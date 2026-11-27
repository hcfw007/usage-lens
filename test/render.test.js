import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTable } from '../lib/render.js';

const ROW = {
  key: 'model-a', requests: 3,
  input: 1_500_000, output: 500_000, cacheRead: 2_000_000, cacheCreation: 0,
  cost: 12.5,
};

test('renderTable formats tokens in M/k, USD, and a cache hint', () => {
  const out = renderTable([ROW], { metric: 'real', dim: 'model' });
  assert.match(out, /^metric=real dim=model/);
  assert.ok(out.includes('4.0M')); // real = 4M
  assert.ok(out.includes('2.0M')); // fresh = 2M
  assert.ok(out.includes('3.5M')); // context = 3.5M
  assert.ok(out.includes('500k')); // output
  assert.ok(out.includes('$12.50'));
  assert.ok(out.includes('cache 50%'));
});

test('renderTable keeps small numbers plain and omits a zero cache hint', () => {
  const row = {
    key: 'tiny', requests: 1,
    input: 400, output: 100, cacheRead: 0, cacheCreation: 0, cost: 0.5,
  };
  const out = renderTable([row], { metric: 'fresh', dim: 'day' });
  assert.ok(out.includes('500')); // fresh = 500 tokens, no suffix
  assert.ok(out.includes('$0.500'));
  assert.equal(/cache \d+%/.test(out), false); // no cache hint without cache reads
});

test('renderTable abbreviates huge token counts without decimals', () => {
  const row = {
    key: 'huge', requests: 1,
    input: 150_000_000, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0,
  };
  assert.ok(renderTable([row], { metric: 'real', dim: 'day' }).includes('150M'));
});

test('renderTable appends session titles up to 72 chars when asked', () => {
  const row = {
    key: 'ses_x', title: 'T'.repeat(80), requests: 1,
    input: 1, output: 1, cacheRead: 0, cacheCreation: 0, cost: 0,
  };
  const out = renderTable([row], { metric: 'real', dim: 'session', showTitle: true });
  assert.ok(out.includes('ses_x'));
  assert.ok(out.includes('T'.repeat(65))); // 'ses_x  ' + 65 T's = 72 chars
  assert.equal(out.includes('T'.repeat(66)), false);
});

test('renderTable renders a header and separators for zero rows', () => {
  const out = renderTable([], { metric: 'real', dim: 'day' });
  const lines = out.split('\n');
  assert.equal(lines.length, 5); // note, sep, header, sep, sep
  assert.ok(lines[2].includes('key'));
  assert.ok(lines[2].includes('cost'));
});

test('renderTable shows a dash for missing token counts and whole-dollar prices', () => {
  const row = {
    key: 'odd', requests: 1,
    input: 0, output: null, cacheRead: 0, cacheCreation: 0, cost: 150,
  };
  const out = renderTable([row], { metric: 'output', dim: 'model' });
  assert.match(out, /\s-\s+\$150/); // output column renders '-', cost rounds to dollars
});
