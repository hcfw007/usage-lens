import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createUsageDb, localEpoch, makeTempDir } from './helpers/fixtures.js';
import { getFreePort, spawnBin } from './helpers/cli.js';
import { request } from './helpers/http.js';

/** The detached CLI logs its banner once the server is listening; poll for it. */
async function waitForLog(pattern, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await readFile(logFile, 'utf8').catch(() => '');
    if (pattern.test(log)) return log;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} in serve.log\n${log}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

let dir;
let cleanup;
let homeDir;
let usageDbPath;
let stateDir;
let pidFile;
let logFile;

// The script keeps its state in ~/.usage-lens; redirecting HOME makes every run
// land in the temp home instead of the real one, and os.homedir() honors $HOME.
const ENV = () => ({
  HOME: homeDir,
  CC_SWITCH_DB: usageDbPath,
  OPENCODE_DB: join(dir, 'no-opencode.db'),
});

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  homeDir = join(dir, 'home');
  usageDbPath = join(dir, 'cc-switch.db');
  stateDir = join(homeDir, '.usage-lens');
  pidFile = join(stateDir, 'serve.pid');
  logFile = join(stateDir, 'serve.log');
  await mkdir(homeDir, { recursive: true });
  createUsageDb(usageDbPath, {
    detail: [
      { at: localEpoch(2026, 10, 13, 12, 0), app: 'claude', model: 'model-a',
        input: 10, output: 1, cost: 0.1 },
    ],
  });
});

beforeEach(() => rm(stateDir, { recursive: true, force: true }));

after(async () => {
  // Best-effort: never leave a detached server behind if a test fails mid-smoke.
  try {
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(stateDir, { recursive: true, force: true });
  await cleanup();
});

test('rejects unknown and missing actions with a usage message', async () => {
  for (const args of [[], ['restart']]) {
    const { code, stderr } = await spawnBin('serve-background.js', args, ENV()).done;
    assert.equal(code, 1);
    assert.match(stderr, /Usage: npm run serve:background/);
  }
});

test('stop with no pid file reports nothing running', async () => {
  const { code, stdout } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
  assert.equal(code, 0);
  assert.match(stdout, /Usage Lens is not running\./);
});

test('stop treats malformed pid files as not running and keeps them', async () => {
  for (const content of ['not-a-number\n', '0\n', '-3\n', '1.5\n', '999999999999999999999\n']) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(pidFile, content);
    const { code, stdout } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
    assert.equal(code, 0);
    assert.match(stdout, /Usage Lens is not running\./);
    await access(pidFile); // ignored, not deleted
  }
});

test('stop removes a stale pid file left by a dead process', async () => {
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise(resolve => dead.on('close', resolve));
  await mkdir(stateDir, { recursive: true });
  await writeFile(pidFile, `${dead.pid}\n`);

  const { code, stdout } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
  assert.equal(code, 0);
  assert.match(stdout, /Removed stale Usage Lens PID file\./);
  await assert.rejects(access(pidFile));
});

test('start refuses to launch a second server when the recorded pid is alive', async () => {
  await mkdir(stateDir, { recursive: true });
  await writeFile(pidFile, `${process.pid}\n`); // the test runner is very much alive

  const { code, stdout } = await spawnBin('serve-background.js', ['start'], ENV()).done;
  assert.equal(code, 0);
  assert.match(stdout, /Usage Lens is already running \(PID \d+\)\./);
  await assert.rejects(access(logFile)); // nothing was spawned
});

test('start without --port prints the default URL and log path', async () => {
  // --metric bogus makes the spawned CLI fail validation before it can bind the
  // default port, so this stays safe even if a real server owns 4782.
  const args = ['start', '--metric', 'bogus'];
  const { code, stdout } = await spawnBin('serve-background.js', args, ENV()).done;
  assert.equal(code, 0);
  assert.match(stdout, /Usage Lens started in background \(PID \d+\)\./);
  assert.match(stdout, /URL: http:\/\/127\.0\.0\.1:4782/);
  assert.ok(stdout.includes(logFile));
});

test('start launches a detached server that stop shuts down gracefully', async () => {
  const port = await getFreePort();
  const startRun = await spawnBin('serve-background.js', ['start', '--port', String(port)], ENV()).done;
  assert.equal(startRun.code, 0);
  assert.match(startRun.stdout, new RegExp(`URL: http://127\\.0\\.0\\.1:${port}`));

  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await access(logFile);

  // "start" only guarantees the spawn; the banner lands in the log when listening.
  await waitForLog(new RegExp(`Usage Lens: http://127\\.0\\.0\\.1:${port}/`));
  const page = await request(port, { path: '/' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('const LIVE_MODE = true;'));

  const stopRun = await spawnBin('serve-background.js', ['stop'], ENV()).done;
  assert.equal(stopRun.code, 0);
  assert.match(stopRun.stdout, /Usage Lens stopped\./);
  await assert.rejects(access(pidFile));
  await assert.rejects(request(port, { path: '/' })); // the server is gone
});

test('stop surfaces non-ENOENT pid file read errors', async () => {
  try {
    await mkdir(pidFile, { recursive: true }); // serve.pid as a directory: reads raise EISDIR
    const { code, stderr } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
    assert.equal(code, 1);
    assert.match(stderr, /EISDIR|illegal operation on a directory/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('stop propagates pid values that cannot be signalled', async () => {
  try {
    await mkdir(stateDir, { recursive: true });
    // A safe integer beyond int32: readPid accepts it, but kill() raises
    // ERR_INVALID_ARG_TYPE — neither EPERM nor ESRCH — so isRunning rethrows.
    await writeFile(pidFile, '1099511627776\n');
    const { code, stderr } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
    assert.equal(code, 1);
    assert.match(stderr, /must be of type number/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('start treats a recorded pid owned by another user as already running', async () => {
  // PID 1 always exists and is owned by root. process.kill(1, 0) probes with
  // signal 0, which delivers nothing: an unprivileged caller gets EPERM and
  // isRunning reports "running". start() never signals the recorded pid, so
  // this is safe even when the suite runs as root (the probe then just
  // succeeds and the same message is printed).
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(pidFile, '1\n');
    const { code, stdout } = await spawnBin('serve-background.js', ['start'], ENV()).done;
    assert.equal(code, 0);
    assert.match(stdout, /Usage Lens is already running \(PID 1\)\./);
    await assert.rejects(access(logFile)); // nothing was spawned
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('stop gives up with an error when the server ignores SIGTERM', async () => {
  const stubborn = spawn(process.execPath, [
    '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ]);
  await new Promise(resolve => stubborn.once('spawn', resolve));
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(pidFile, `${stubborn.pid}\n`);
    const { code, stderr } = await spawnBin('serve-background.js', ['stop'], ENV()).done;
    assert.equal(code, 1);
    assert.match(stderr, /did not stop within 5 seconds/);
    await access(pidFile); // the pid file is kept when the process would not die
  } finally {
    stubborn.kill('SIGKILL');
    await rm(stateDir, { recursive: true, force: true });
  }
});
