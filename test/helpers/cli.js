import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');
const CLI = join(BIN_DIR, 'cli.js');

/**
 * Run bin/cli.js in a subprocess and capture its outcome.
 * Extra env (e.g. CC_SWITCH_DB, OPENCODE_DB) is merged over the parent env.
 */
export function runCli(args, env = {}, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/**
 * Spawn a bin/ script and keep its output observable while it runs.
 * Returns { child, output, exited, done }: `output` fills up as the process
 * writes, `exited.value` becomes { code, signal } once it closes, and `done`
 * resolves to the full { code, signal, stdout, stderr } outcome.
 */
export function spawnBin(script, args = [], env = {}) {
  const child = spawn(process.execPath, [join(BIN_DIR, script), ...args], {
    env: { ...process.env, ...env },
  });
  const output = { stdout: '', stderr: '' };
  const exited = { value: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      exited.value = { code, signal };
      resolve({ code, signal, stdout: output.stdout, stderr: output.stderr });
    });
  });
  return { child, output, exited, done };
}

/** Resolve once `pattern` appears on one of the spawned process's streams. */
export async function waitForOutput(handle, pattern, { stream = 'stdout', timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(handle.output[stream])) {
    if (handle.exited.value) {
      throw new Error(
        `process exited (${handle.exited.value.code}) before matching ${pattern}\n` +
        `stdout: ${handle.output.stdout}\nstderr: ${handle.output.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pattern} on ${stream}\n${handle.output[stream]}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Ask the OS for a currently free localhost TCP port. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}
