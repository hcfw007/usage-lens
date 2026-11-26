import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');

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
