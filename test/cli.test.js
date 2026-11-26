import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { createOpencodeDb, createUsageDb, localEpoch, makeTempDir } from './helpers/fixtures.js';
import { runCli } from './helpers/cli.js';

let dir;
let cleanup;
let usageDbPath;
let emptyDbPath;

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  usageDbPath = join(dir, 'cc-switch.db');
  emptyDbPath = join(dir, 'empty.db');
  createUsageDb(usageDbPath, {
    detail: [
      { at: localEpoch(2026, 10, 13, 12, 15), app: 'claude', model: 'model-a', session: 'ses_abc',
        input: 100, output: 10, cacheRead: 50, cacheCreation: 5, cost: 0.5 },
      { at: localEpoch(2026, 10, 14, 8, 0), app: 'opencode', model: 'model-b',
        input: 5, output: 5, cost: 0.01 },
    ],
    rollups: [
      { date: '2026-10-12', app: 'claude', model: 'model-a', requests: 7,
        input: 700, output: 70, cacheRead: 7000, cacheCreation: 70, cost: 1.25 },
    ],
  });
  createUsageDb(emptyDbPath);
});

after(() => cleanup());

// OPENCODE_DB points outside the fixture so title joins stay deterministic.
const ENV = () => ({ OPENCODE_DB: join(dir, 'no-opencode.db') });

test('prints usage and exits 0 on --help', async () => {
  const { code, stdout } = await runCli(['--help'], ENV());
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /real {4}= in \+ out \+ cacheRead \+ cacheCreation/);
});

test('rejects unknown options with exit 1', async () => {
  const { code, stderr } = await runCli(['--bogus'], ENV());
  assert.equal(code, 1);
  assert.match(stderr, /unknown option: --bogus/);
});

test('rejects unknown metrics before doing any work', async () => {
  const { code, stderr } = await runCli(['model', '--metric', 'bogus'], ENV());
  assert.equal(code, 1);
  assert.match(stderr, /unknown metric: bogus/);
});

test('defaults to the day dimension and prints a table', async () => {
  const { code, stdout } = await runCli(['--db', usageDbPath], ENV());
  assert.equal(code, 0);
  assert.match(stdout, /metric=real dim=day/);
  for (const date of ['2026-10-12', '2026-10-13', '2026-10-14']) {
    assert.ok(stdout.includes(date), `missing ${date}`);
  }
});

test('session dimension joins titles best-effort and honors --limit', async () => {
  const all = await runCli(['session', '--db', usageDbPath], ENV());
  assert.equal(all.code, 0);
  assert.ok(all.stdout.includes('ses_abc'));
  assert.ok(all.stdout.includes('(no session)')); // empty session ids get a visible bucket

  const limited = await runCli(['session', '--db', usageDbPath, '--limit', '1'], ENV());
  assert.equal(limited.code, 0);
  assert.ok(limited.stdout.includes('(no session)')); // highest real row comes first
  assert.equal(limited.stdout.includes('ses_abc'), false);
});

test('html writes a self-contained report to --out', async () => {
  const out = join(dir, 'report.html');
  const { code, stdout } = await runCli(
    ['html', '--db', usageDbPath, '--from', '2026-10-12', '--to', '2026-10-14', '--out', out],
    ENV(),
  );
  assert.equal(code, 0);
  assert.match(stdout, /report written/);
  const html = await readFile(out, 'utf8');
  assert.equal(html.includes('/*__DATA__*/null'), false);
  assert.equal(html.includes('/*__LIVE__*/false'), true);
});

test('html reports "no data" instead of writing an empty report', async () => {
  const out = join(dir, 'untouched.html');
  const { code, stdout } = await runCli(
    ['html', '--db', usageDbPath, '--from', '2000-01-01', '--to', '2000-01-02', '--out', out],
    ENV(),
  );
  assert.equal(code, 0);
  assert.match(stdout, /no data between 2000-01-01 and 2000-01-02/);
  await assert.rejects(access(out));
});

test('html --all on an empty database says so', async () => {
  const { code, stdout } = await runCli(['html', '--all', '--db', emptyDbPath], ENV());
  assert.equal(code, 0);
  assert.match(stdout, /database has no usage data yet/);
});

test('fails with a clear message when the database is missing', async () => {
  const { code, stderr } = await runCli(['day', '--db', join(dir, 'gone.db')], ENV());
  assert.equal(code, 1);
  assert.match(stderr, /cc-switch database not found/);
});

test('validates --port before starting the server', async () => {
  const { code, stderr } = await runCli(['serve', '--port', '0', '--db', usageDbPath], ENV());
  assert.equal(code, 1);
  assert.match(stderr, /--port must be/);
});

test('filters rows by app with --app', async () => {
  const { code, stdout } = await runCli(['app', '--app', 'claude', '--db', usageDbPath], ENV());
  assert.equal(code, 0);
  assert.match(stdout, /claude/);
  assert.equal(stdout.includes('opencode'), false);
});

test('dimension commands report "no data" for empty filters', async () => {
  const { code, stdout } = await runCli(['day', '--db', emptyDbPath], ENV());
  assert.equal(code, 0);
  assert.match(stdout, /no data for the given filters/);
});

test('html defaults to cc-usage-report.html in the working directory', async () => {
  const cwd = join(dir, 'html-default');
  await mkdir(cwd, { recursive: true });
  const args = ['html', '--db', usageDbPath, '--from', '2026-10-12', '--to', '2026-10-14'];
  const { code, stdout } = await runCli(args, ENV(), cwd);
  assert.equal(code, 0);
  assert.match(stdout, /report written: cc-usage-report\.html/);
  const html = await readFile(join(cwd, 'cc-usage-report.html'), 'utf8');
  assert.equal(html.includes('/*__DATA__*/null'), false);
});

test('html embeds joined session titles', async () => {
  const opencodeDb = join(dir, 'opencode-titles.db');
  createOpencodeDb(opencodeDb, [{ id: 'ses_abc', title: 'My titled session' }]);
  const out = join(dir, 'titled-report.html');
  const { code } = await runCli(
    ['html', '--db', usageDbPath, '--from', '2026-10-12', '--to', '2026-10-14', '--out', out],
    { ...ENV(), OPENCODE_DB: opencodeDb },
  );
  assert.equal(code, 0);
  assert.ok((await readFile(out, 'utf8')).includes('My titled session'));
});

test('serve falls back to the default port when --port is omitted', async () => {
  // Occupy 4782 so the spawned server fails fast with EADDRINUSE: the default
  // port resolution still executes. If something else already owns the port,
  // the bind below fails and the observable outcome is identical.
  const blocker = createServer();
  const blocked = await new Promise(resolve => {
    blocker.once('error', () => resolve(false));
    blocker.listen(4782, '127.0.0.1', () => resolve(true));
  });
  try {
    const { code, stderr } = await runCli(['serve', '--db', usageDbPath], ENV());
    assert.equal(code, 1);
    assert.match(stderr, /EADDRINUSE|address already in use/i);
  } finally {
    if (blocked) await new Promise(resolve => blocker.close(resolve));
  }
});
