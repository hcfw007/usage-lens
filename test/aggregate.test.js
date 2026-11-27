import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { METRICS, aggregate, withSessionTitles } from '../lib/aggregate.js';
import { openReadOnly } from '../lib/db.js';
import { createOpencodeDb, makeTempDir } from './helpers/fixtures.js';

const ROW = {
  date: '2026-10-13', app: 'claude', model: 'model-a', session: 'ses_1',
  requests: 2, input: 120, output: 12, cacheRead: 50, cacheCreation: 5, cost: 0.6,
};

let dir;
let cleanup;
let opencodeDbPath;

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  opencodeDbPath = join(dir, 'opencode.db');
  createOpencodeDb(opencodeDbPath, [
    { id: 'ses_exact', title: 'Exact title' },
    { id: 'ses_abcdefghij012345', title: 'Prefix title' },
    { id: 'ses_exact', title: 'Duplicate id wins first' },
  ]);
});

after(() => cleanup());

test('METRICS implement the documented formulas', () => {
  assert.equal(METRICS.real(ROW), 187); // in+out+cacheRead+cacheCreation
  assert.equal(METRICS.fresh(ROW), 132); // in+out
  assert.equal(METRICS.context(ROW), 170); // in+cacheRead
  assert.equal(METRICS.output(ROW), 12);
  assert.equal(METRICS.cost(ROW), 0.6);
});

test('aggregate groups and sums rows per dimension key', () => {
  const rows = [ROW, { ...ROW, input: 80, output: 8, requests: 1 }];
  const [only] = aggregate(rows, 'day');
  assert.equal(only.key, '2026-10-13');
  assert.equal(only.requests, 3);
  assert.equal(only.input, 200);
  assert.equal(only.output, 20);

  assert.deepEqual(aggregate([ROW], 'model').map(r => r.key), ['model-a']);
  assert.deepEqual(aggregate([ROW], 'app').map(r => r.key), ['claude']);
  assert.deepEqual(
    aggregate([{ ...ROW, session: '' }], 'session').map(r => r.key),
    ['(no session)'],
  );
  assert.deepEqual(aggregate([ROW], 'day+model').map(r => r.key), ['2026-10-13  model-a']);
  assert.deepEqual(aggregate([ROW], 'day+app').map(r => r.key), ['2026-10-13  claude']);
});

test('aggregate sorts by the chosen metric descending and honors limit', () => {
  const rows = [
    { ...ROW, session: 'low', cost: 0.1, input: 1, output: 1 },
    { ...ROW, session: 'high', cost: 9.9, input: 1, output: 1 },
    { ...ROW, session: 'mid', cost: 0.5, input: 1, output: 1 },
  ];
  assert.deepEqual(
    aggregate(rows, 'session', { metric: 'cost' }).map(r => r.key),
    ['high', 'mid', 'low'],
  );
  assert.deepEqual(
    aggregate(rows, 'session', { metric: 'cost', limit: 2 }).map(r => r.key),
    ['high', 'mid'],
  );
});

test('aggregate rejects unknown dimensions and metrics', () => {
  assert.throws(() => aggregate([ROW], 'nope'), /unknown dimension/);
  assert.throws(() => aggregate([ROW], 'day', { metric: 'nope' }), /unknown metric/);
});

test('withSessionTitles matches by exact id, then 20-char prefix', async () => {
  const rows = [
    { key: 'ses_exact' },
    { key: 'ses_abcdefghij0123456789' }, // longer than opencode's id: prefix fallback
    { key: 'ses_unknown' },
  ];
  await withSessionTitles(rows, () => openReadOnly(opencodeDbPath));
  assert.equal(rows[0].title, 'Exact title');
  assert.equal(rows[1].title, 'Prefix title');
  assert.equal(rows[2].title, '');
});

test('withSessionTitles skips non-session keys without opening a database', async () => {
  let opened = false;
  const rows = [{ key: '2026-10-13' }];
  await withSessionTitles(rows, async () => {
    opened = true;
    throw new Error('must not be reached');
  });
  assert.equal(opened, false);
  assert.equal('title' in rows[0], false);
});

test('withSessionTitles is best-effort when the opencode db is unreadable', async () => {
  const rows = [{ key: 'ses_exact' }, { key: 'ses_abcdefghij0123456789' }];
  await withSessionTitles(rows, async () => {
    throw new Error('opencode db gone');
  });
  assert.deepEqual(rows.map(r => r.key), ['ses_exact', 'ses_abcdefghij0123456789']);
  assert.equal(rows.every(r => !('title' in r)), true);
});
