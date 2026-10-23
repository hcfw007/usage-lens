#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const stateDir = path.join(os.homedir(), '.usage-lens');
const pidFile = path.join(stateDir, 'serve.pid');
const logFile = path.join(stateDir, 'serve.log');
const cliFile = fileURLToPath(new URL('./cli.js', import.meta.url));

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function readPid() {
  try {
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function start() {
  await mkdir(stateDir, { recursive: true });
  const existingPid = await readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`Usage Lens is already running (PID ${existingPid}).`);
    return;
  }
  await rm(pidFile, { force: true });

  const log = await open(logFile, 'a');
  const child = spawn(process.execPath, [cliFile, 'serve', ...process.argv.slice(3)], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    cwd: process.cwd(),
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
  await log.close();
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? process.argv[portIndex + 1] : '4782';
  console.log(`Usage Lens started in background (PID ${child.pid}).`);
  console.log(`URL: http://127.0.0.1:${port}`);
  console.log(`Log: ${logFile}`);
}

async function stop() {
  const pid = await readPid();
  if (!pid) {
    console.log('Usage Lens is not running.');
    return;
  }
  if (!isRunning(pid)) {
    await rm(pidFile, { force: true });
    console.log('Removed stale Usage Lens PID file.');
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && isRunning(pid); attempt++) await delay(100);
  if (isRunning(pid)) throw new Error(`Usage Lens (PID ${pid}) did not stop within 5 seconds.`);
  await rm(pidFile, { force: true });
  console.log('Usage Lens stopped.');
}

const action = process.argv[2];
try {
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else throw new Error('Usage: npm run serve:background [-- --port PORT] | npm run serve:stop');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
