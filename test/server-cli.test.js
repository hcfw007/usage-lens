import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createUsageDb, localEpoch, makeTempDir } from './helpers/fixtures.js';
import { getFreePort, runCli, spawnBin, waitForOutput } from './helpers/cli.js';
import { request } from './helpers/http.js';

let dir;
let cleanup;
let usageDbPath;

const ENV = () => ({ OPENCODE_DB: join(dir, 'no-opencode.db') });

/**
 * A leaked serve child pins the test process's event loop and node --test never
 * exits, so every failure path must still reap the subprocess.
 */
function killOnFailure(t, handle) {
  t.after(() => {
    if (!handle.exited.value) handle.child.kill('SIGKILL');
  });
}

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  usageDbPath = join(dir, 'cc-switch.db');
  createUsageDb(usageDbPath, {
    detail: [
      { at: localEpoch(2026, 10, 13, 12, 0), app: 'claude', model: 'model-a',
        input: 10, output: 1, cost: 0.1 },
    ],
  });
});

after(() => cleanup());

test('serve prints its banner, answers requests, and exits 0 on SIGTERM', async t => {
  const port = await getFreePort();
  const handle = spawnBin('cli.js', ['serve', '--port', String(port), '--db', usageDbPath], ENV());
  killOnFailure(t, handle);
  // The banner is three separate writes; wait for the last line so all of them
  // are in the buffer before asserting on the earlier ones.
  await waitForOutput(handle, /Auto-refresh: every 5 minutes/);
  assert.ok(handle.output.stdout.includes(`Usage Lens: http://127.0.0.1:${port}/`));
  assert.ok(handle.output.stdout.includes(`Database:   ${usageDbPath}`));

  const page = await request(port, { path: '/' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('const LIVE_MODE = true;'));

  handle.child.kill('SIGTERM');
  const result = await handle.done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test('serve exits 0 on SIGINT', async t => {
  const port = await getFreePort();
  const handle = spawnBin('cli.js', ['serve', '--port', String(port), '--db', usageDbPath], ENV());
  killOnFailure(t, handle);
  await waitForOutput(handle, /Auto-refresh: every 5 minutes/);

  handle.child.kill('SIGINT');
  const result = await handle.done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test('serve rejects --port values outside 1..65535', async () => {
  for (const port of ['70000', 'abc']) {
    const { code, stderr } = await runCli(['serve', '--port', port, '--db', usageDbPath], ENV());
    assert.equal(code, 1);
    assert.match(stderr, /--port must be an integer from 1 to 65535/);
  }
});

test('serve fails before listening when the database is missing', async () => {
  const port = await getFreePort();
  const { code, stderr } = await runCli(
    ['serve', '--port', String(port), '--db', join(dir, 'gone.db')],
    ENV(),
  );
  assert.equal(code, 1);
  assert.match(stderr, /cc-switch database not found/);
});
