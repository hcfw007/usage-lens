import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORT_WINDOW_DAYS,
  localDate,
  shiftDate,
  reportWindow,
  buildReport,
  buildReportData,
  buildLivePage,
} from '../lib/report.js';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'report.html');

const ROWS = [
  { date: '2026-10-13', app: '<claude>', model: 'model-a', session: 'ses_1',
    requests: 2, input: 120, output: 12, cacheRead: 50, cacheCreation: 5, cost: 0.6 },
  { date: '2026-10-20', app: '<claude>', model: '', session: '',
    requests: 1, input: 5, output: 5, cacheRead: 0, cacheCreation: 0, cost: 0.012345 },
  { date: '2026-11-01', app: 'opencode', model: 'model-b', session: 'ses_2',
    requests: 9, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, cost: 1 },
];

const TITLES = new Map([['ses_1', 'My session']]);

test('localDate formats a local YYYY-MM-DD', () => {
  assert.equal(localDate(new Date(2026, 10, 26)), '2026-11-26');
});

test('shiftDate crosses month and year boundaries', () => {
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2026-03-05', -29), '2026-02-04');
});

test('reportWindow defaults to the last REPORT_WINDOW_DAYS ending today', () => {
  const today = localDate(new Date());
  const win = reportWindow({});
  assert.deepEqual(win, {
    start: shiftDate(today, -(REPORT_WINDOW_DAYS - 1)),
    end: today,
    clamped: false,
  });
});

test('reportWindow honors explicit ranges and clamps end to start', () => {
  const today = localDate(new Date());
  assert.deepEqual(reportWindow({ from: '2026-01-01' }), { start: '2026-01-01', end: today, clamped: false });
  assert.deepEqual(
    reportWindow({ from: '2026-03-10', to: '2026-03-01' }),
    { start: '2026-03-10', end: '2026-03-10', clamped: false },
  );
  assert.deepEqual(
    reportWindow({ to: '2026-03-05' }),
    { start: '2026-02-04', end: '2026-03-05', clamped: false },
  );
});

test('buildReportData filters to the range and dictionary-encodes rows', () => {
  const data = buildReportData(ROWS, { start: '2026-10-01', end: '2026-10-31', titles: TITLES });
  assert.ok(!Number.isNaN(Date.parse(data.generated)));
  assert.equal(data.start, '2026-10-01');
  assert.equal(data.end, '2026-10-31');

  assert.deepEqual(data.apps, ['<claude>']);
  assert.deepEqual(data.models, ['model-a', '(unknown)']);
  assert.deepEqual(data.sessions, ['ses_1', '']);
  assert.deepEqual(data.titles, ['My session', '']);

  assert.deepEqual(data.rows, [
    ['2026-10-13', 0, 0, 0, 2, 120, 12, 50, 5, 0.6],
    ['2026-10-20', 0, 1, 1, 1, 5, 5, 0, 0, 0.0123], // cost rounded to 4 decimals
  ]);
});

test('buildReportData keeps intraday rows at date x slot granularity', () => {
  const intraday = [
    { date: '2026-10-13', slot: 24, app: '<claude>', model: 'model-a',
      requests: 1, input: 100, output: 10, cacheRead: 50, cacheCreation: 5, cost: 0.5 },
  ];
  const data = buildReportData(ROWS, {
    start: '2026-10-01', end: '2026-10-31', titles: TITLES, intraday,
  });
  assert.deepEqual(data.intraday, [['2026-10-13', 24, 0, 0, 1, 100, 10, 50, 5, 0.5]]);
});

test('the template holds exactly one data and one live placeholder', async () => {
  const template = await readFile(TEMPLATE, 'utf8');
  assert.equal(template.split('/*__DATA__*/null').length, 2);
  assert.equal(template.split('/*__LIVE__*/false').length, 2);
});

test('buildReport injects escaped JSON and leaves the live flag off', async () => {
  const html = await buildReport(ROWS, { start: '2026-10-01', end: '2026-10-31', titles: TITLES });
  assert.equal(html.includes('/*__DATA__*/null'), false);
  assert.equal(html.includes('/*__LIVE__*/false'), true);
  assert.equal(html.includes('"start":"2026-10-01"'), true);
  // "<" is escaped as \u003c so the JSON cannot break out of <script>
  assert.equal(html.includes('\\u003cclaude>'), true);
  assert.equal(html.includes('<claude>'), false);
});

test('buildLivePage flips the live flag and keeps the data placeholder', async () => {
  const html = await buildLivePage();
  assert.equal(html.includes('const LIVE_MODE = true;'), true);
  assert.equal(html.includes('/*__LIVE__*/'), false);
  assert.equal(html.includes('/*__DATA__*/null'), true);
});
