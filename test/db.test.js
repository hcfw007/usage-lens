import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCCSwitchDb,
  openReadOnly,
  dispose,
  loadRows,
  loadEarliestDate,
  loadIntradayRows,
} from '../lib/db.js';
import { createUsageDb, createBareDb, localEpoch, makeTempDir } from './helpers/fixtures.js';

let dir;
let cleanup;
let usageDbPath;
let emptyDbPath;
let bareDbPath;
let corruptDbPath;

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  usageDbPath = join(dir, 'cc-switch.db');
  emptyDbPath = join(dir, 'empty.db');
  bareDbPath = join(dir, 'bare.db');
  corruptDbPath = join(dir, 'corrupt.db');

  createUsageDb(usageDbPath, {
    detail: [
      { at: localEpoch(2026, 10, 13, 12, 15), app: 'claude', model: 'model-a', session: 'ses_abc',
        input: 100, output: 10, cacheRead: 50, cacheCreation: 5, cost: 0.25 },
      // cache-unreported row: input > 0 with no cache columns at all
      { at: localEpoch(2026, 10, 13, 12, 45), app: 'claude', model: 'model-a', session: 'ses_abc',
        input: 20, output: 2, cost: 0.25 },
      { at: localEpoch(2026, 10, 14, 8, 0), app: 'opencode', model: 'model-b',
        input: 5, output: 5, cost: 0.01 },
    ],
    rollups: [
      { date: '2026-10-12', app: 'claude', model: 'model-a', requests: 7,
        input: 700, output: 70, cacheRead: 7000, cacheCreation: 70, cost: 1.25 },
    ],
  });
  createUsageDb(emptyDbPath);
  createBareDb(bareDbPath);
  await writeFile(corruptDbPath, 'this is definitely not a sqlite database');
});

after(() => cleanup());

test('resolveCCSwitchDb returns an explicit path that exists', async () => {
  assert.equal(await resolveCCSwitchDb(usageDbPath), usageDbPath);
});

test('resolveCCSwitchDb rejects a missing explicit path and lists it', async () => {
  const missing = join(dir, 'nope.db');
  await assert.rejects(resolveCCSwitchDb(missing), err => {
    assert.match(err.message, /cc-switch database not found/);
    assert.ok(err.message.includes(missing));
    return true;
  });
});

test('resolveCCSwitchDb honors CC_SWITCH_DB', async (t) => {
  const previous = process.env.CC_SWITCH_DB;
  t.after(() => {
    if (previous === undefined) delete process.env.CC_SWITCH_DB;
    else process.env.CC_SWITCH_DB = previous;
  });
  process.env.CC_SWITCH_DB = usageDbPath;
  assert.equal(await resolveCCSwitchDb(), usageDbPath);

  process.env.CC_SWITCH_DB = join(dir, 'gone.db');
  await assert.rejects(resolveCCSwitchDb(), /cc-switch database not found/);
});

test('openReadOnly reads the database and dispose closes it', async () => {
  const db = await openReadOnly(usageDbPath);
  assert.ok(loadRows(db).length > 0);
  await dispose(db);
  assert.throws(() => loadRows(db));
});

test('a corrupt database file fails with a clear error', async () => {
  await assert.rejects(async () => {
    const db = await openReadOnly(corruptDbPath);
    try {
      loadRows(db); // corruption surfaces on first use if not at open
    } finally {
      await dispose(db);
    }
  }, /not a database|unable to open|file is/i);
});

test('a database missing the usage tables fails with a clear error', async () => {
  const db = await openReadOnly(bareDbPath);
  try {
    assert.throws(() => loadRows(db), /no such table/);
    assert.throws(() => loadEarliestDate(db), /no such table/);
  } finally {
    await dispose(db);
  }
});

test('an empty (tables present, no rows) database degrades gracefully', async () => {
  const db = await openReadOnly(emptyDbPath);
  try {
    assert.deepEqual(loadRows(db), []);
    assert.equal(loadEarliestDate(db), null);
  } finally {
    await dispose(db);
  }
});

test('loadRows merges detail rows and rollups with era-correct grouping', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    const rows = loadRows(db);
    assert.equal(rows.length, 3);

    // node:sqlite rows have a null prototype; spread before deep comparison
    const grouped = rows.find(r => r.date === '2026-10-13');
    assert.deepEqual({ ...grouped }, {
      date: '2026-10-13', app: 'claude', model: 'model-a', session: 'ses_abc',
      requests: 2, input: 120, output: 12, cacheRead: 50, cacheCreation: 5, cost: 0.5,
    });

    const rollup = rows.find(r => r.date === '2026-10-12');
    assert.equal(rollup.session, '');
    assert.equal(rollup.requests, 7);
    assert.equal(rollup.cacheRead, 7000);
  } finally {
    await dispose(db);
  }
});

test('loadRows applies from/to inclusively across both tables', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    assert.deepEqual(
      loadRows(db, { from: '2026-10-13', to: '2026-10-13' }).map(r => r.date),
      ['2026-10-13'],
    );
    assert.deepEqual(
      loadRows(db, { from: '2026-10-12', to: '2026-10-14' }).map(r => r.date).sort(),
      ['2026-10-12', '2026-10-13', '2026-10-14'],
    );
    assert.deepEqual(loadRows(db, { from: '2026-10-15' }), []);
  } finally {
    await dispose(db);
  }
});

test('loadRows filters by app, treating "all" as no filter', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    assert.deepEqual(
      loadRows(db, { app: 'claude' }).map(r => r.app).sort(),
      ['claude', 'claude'],
    );
    assert.equal(loadRows(db, { app: 'all' }).length, 3);
  } finally {
    await dispose(db);
  }
});

test('loadEarliestDate finds the earliest day across both eras', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    assert.equal(loadEarliestDate(db), '2026-10-12');
  } finally {
    await dispose(db);
  }
});

test('loadIntradayRows buckets request rows into 30-minute slots', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    const rows = loadIntradayRows(db, { date: '2026-10-13' });
    assert.deepEqual(rows.map(r => r.slot), [24, 25]); // 12:15 and 12:45
    assert.equal(rows[0].requests, 1);
    assert.equal(rows[0].input, 100);
  } finally {
    await dispose(db);
  }
});

test('loadIntradayRows covers an inclusive day range and ignores rollups', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    const rows = loadIntradayRows(db, { from: '2026-10-12', to: '2026-10-14' });
    // 2026-10-12 is rollup-only: no slot rows, and nothing invented for it
    assert.deepEqual([...new Set(rows.map(r => r.date))], ['2026-10-13', '2026-10-14']);
    assert.equal(rows.find(r => r.date === '2026-10-14').slot, 16); // 08:00
  } finally {
    await dispose(db);
  }
});

test('loadIntradayRows rejects malformed or inverted ranges', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    assert.deepEqual(loadIntradayRows(db, {}), []);
    assert.deepEqual(loadIntradayRows(db, { date: '2026-10-13' }).length > 0, true);
    assert.deepEqual(loadIntradayRows(db, { date: '10/13/2026' }), []);
    assert.deepEqual(loadIntradayRows(db, { from: '2026-10-14', to: '2026-10-13' }), []);
  } finally {
    await dispose(db);
  }
});

test('loadIntradayRows accepts every documented range shape', async () => {
  const db = await openReadOnly(usageDbPath);
  try {
    const cases = [
      [{ from: '2026-10-13' }, n => n > 0], // end day falls back to the start day
      [{ to: '2026-10-13' }, n => n === 0], // no start day at all
      [{ from: '2026-10-13', to: '' }, n => n === 0], // empty end overrides the fallback
      [{ date: '2026-10-13', from: '2026-10-14', to: '2026-10-15' }, n => n > 0], // date wins
      [{ from: '2026-10-13', to: 'bad' }, n => n === 0], // end fails the format check
      [{ date: 'bad', from: '2026-10-13' }, n => n === 0], // date takes precedence
      [{ from: '2026-13-99' }, n => n === 0], // well-formed but not a real day
      [{ from: '2026-10-13', to: '2026-10-99' }, n => n === 0], // invalid end day
    ];
    for (const [range, check] of cases) {
      assert.equal(check(loadIntradayRows(db, range).length), true, JSON.stringify(range));
    }
  } finally {
    await dispose(db);
  }
});

test('openReadOnly rethrows open errors that are not retryable', async () => {
  // A directory opens with "disk I/O error", which matches neither
  // /unable to open|locked|busy/ nor anything a snapshot copy could fix.
  const notADb = join(dir, 'not-a-db-dir');
  await mkdir(notADb, { recursive: true });
  await assert.rejects(openReadOnly(notADb), /disk I\/O error|unable to open/);
});

test('openReadOnly retries a snapshot copy for openable-later errors', async (t) => {
  // A missing file fails with "unable to open database file": the retryable
  // branch runs (temp copy), and the copy itself then fails with ENOENT.
  // The successful-snapshot path after the copy is not constructible without
  // mocking node:sqlite: its open is lazy, so neither lock conflicts ("locked")
  // nor file corruption surface at construction, and every construction-time
  // failure we can produce (missing, unreadable) fails cp() identically.
  const leakedBefore = new Set((await readdir(tmpdir())).filter(n => n.startsWith('ccusage-')));
  t.after(async () => {
    for (const name of (await readdir(tmpdir())).filter(n => n.startsWith('ccusage-'))) {
      if (!leakedBefore.has(name)) await rm(join(tmpdir(), name), { recursive: true, force: true });
    }
  });
  await assert.rejects(openReadOnly(join(dir, 'gone.db')), /ENOENT|no such file/i);
});

test('dispose removes the snapshot temp directory recorded on the db handle', async () => {
  // openReadOnly attaches _tempDir to snapshot handles. Reaching a successful
  // snapshot through openReadOnly is not constructible (see the test above),
  // so exercise dispose's documented cleanup contract with an injected handle.
  const snapshotDir = join(dir, 'snapshot-tmp');
  await mkdir(snapshotDir, { recursive: true });
  let closed = false;
  await dispose({ close: () => { closed = true; }, _tempDir: snapshotDir });
  assert.equal(closed, true);
  await assert.rejects(access(snapshotDir));
});
