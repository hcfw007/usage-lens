import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'report.html');

/** The HTML report covers at most this many days (inclusive of the end day). */
export const REPORT_WINDOW_DAYS = 30;

/** YYYY-MM-DD in the local timezone. */
export function localDate(d) {
  return d.toLocaleDateString('sv-SE');
}

export function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a report range. An explicit `from` is honored as-is (even beyond
 * REPORT_WINDOW_DAYS); without one the window defaults to the last
 * REPORT_WINDOW_DAYS days ending at `to` (default today).
 */
export function reportWindow({ from, to }) {
  const end = to ?? localDate(new Date());
  if (from) return { start: from, end: end < from ? from : end, clamped: false };
  return { start: shiftDate(end, -(REPORT_WINDOW_DAYS - 1)), end, clamped: false };
}

function dictionary() {
  const list = [];
  const index = new Map();
  const id = value => {
    if (!index.has(value)) { index.set(value, list.length); list.push(value); }
    return index.get(value);
  };
  return { list, id };
}

/**
 * Build a self-contained HTML report. Rows stay at day x app x model x session
 * granularity so the page can re-aggregate any date range client-side.
 * Strings are dictionary-encoded to keep the embedded JSON small.
 */
export async function buildReport(rows, { start, end, titles = new Map(), intraday = [] }) {
  const data = buildReportData(rows, { start, end, titles, intraday });
  const template = await readFile(TEMPLATE, 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c'); // safe inside <script>
  return template.replace('/*__DATA__*/null', () => json);
}

/** Create compact JSON data shared by static exports and the local API. */
export function buildReportData(rows, { start, end, titles = new Map(), intraday = [] }) {
  const apps = dictionary();
  const models = dictionary();
  const sessions = dictionary();
  const compact = rows
    .filter(r => r.date >= start && r.date <= end)
    .map(r => [
      r.date, apps.id(r.app), models.id(r.model || '(unknown)'), sessions.id(r.session || ''),
      r.requests ?? 0, r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheCreation ?? 0,
      Math.round((r.cost ?? 0) * 1e4) / 1e4,
    ]);
  // Intraday rows keep their own date so a single payload can serve any day's
  // 30-minute view. Session is dropped here: the chart is aggregate-only.
  const compactIntraday = intraday.map(r => [
    r.date, r.slot, apps.id(r.app), models.id(r.model || '(unknown)'),
    r.requests ?? 0, r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheCreation ?? 0,
    Math.round((r.cost ?? 0) * 1e4) / 1e4,
  ]);

  const data = {
    generated: new Date().toISOString(),
    start, end,
    apps: apps.list,
    models: models.list,
    sessions: sessions.list,
    titles: sessions.list.map(s => titles.get(s) ?? ''),
    rows: compact,
    intraday: compactIntraday,
  };

  return data;
}

/** Return the interactive page shell; live data is fetched from the same-origin API. */
export async function buildLivePage() {
  const template = await readFile(TEMPLATE, 'utf8');
  return template.replace('/*__LIVE__*/false', 'true');
}
