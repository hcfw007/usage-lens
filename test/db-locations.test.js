import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { makeTempDir } from './helpers/fixtures.js';

// This file runs in its own test process and imports lib/db.js only after
// HOME has been redirected, so the module-level HOME constant points at the
// probe fixture instead of the real home directory.
let dir;
let cleanup;
let home;
let homeEnv;
let profile;
let homeDb;
let linuxDb;
let windowsDb;
let homeEnvDb;
let resolveCCSwitchDb;

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  home = join(dir, 'home');
  homeEnv = join(dir, 'home-env');
  profile = join(dir, 'profile');
  homeDb = join(home, '.cc-switch', 'cc-switch.db');
  linuxDb = join(home, '.config', 'cc-switch', 'cc-switch.db');
  windowsDb = join(profile, '.cc-switch', 'cc-switch.db');
  homeEnvDb = join(homeEnv, 'cc-switch.db');

  // Only existence matters to resolveCCSwitchDb, so empty files suffice.
  for (const path of [homeDb, linuxDb, windowsDb, homeEnvDb]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
  }

  process.env.HOME = home;
  ({ resolveCCSwitchDb } = await import('../lib/db.js'));
});

after(() => cleanup());

test('resolveCCSwitchDb probes conventional locations without env hints', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const envKeys = ['CC_SWITCH_DB', 'CC_SWITCH_HOME', 'USERPROFILE'];
  const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  delete process.env.CC_SWITCH_DB;
  delete process.env.CC_SWITCH_HOME;
  delete process.env.USERPROFILE;

  process.env.CC_SWITCH_HOME = homeEnv;
  assert.equal(await resolveCCSwitchDb(), homeEnvDb);

  delete process.env.CC_SWITCH_HOME;
  assert.equal(await resolveCCSwitchDb(), homeDb);

  await rm(homeDb, { force: true }); // clear the home candidate so later ones win
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.USERPROFILE = profile;
  assert.equal(await resolveCCSwitchDb(), windowsDb);

  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  delete process.env.USERPROFILE;
  assert.equal(await resolveCCSwitchDb(), linuxDb);
});

test('resolveCCSwitchDb reports every probed path when nothing exists', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = { CC_SWITCH_HOME: process.env.CC_SWITCH_HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    for (const key of ['CC_SWITCH_HOME', 'USERPROFILE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  delete process.env.CC_SWITCH_DB;
  delete process.env.CC_SWITCH_HOME;
  delete process.env.USERPROFILE;
  for (const path of [homeDb, linuxDb, windowsDb]) await rm(path, { force: true });

  await assert.rejects(resolveCCSwitchDb(), err => {
    assert.match(err.message, /cc-switch database not found/);
    assert.ok(err.message.includes(homeDb));
    return true;
  });
});
