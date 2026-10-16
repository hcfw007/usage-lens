#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { openReadOnly, dispose, loadRows, resolveCCSwitchDb, OPENCODE_DB } from '../lib/db.js';
import { aggregate, withSessionTitles, METRICS } from '../lib/aggregate.js';
import { renderTable } from '../lib/render.js';

const USAGE = `ulens — multi-metric usage lens over cc-switch's database

Usage:
  ulens [dim] [options]
  ulens html [options]      self-contained HTML report (last 30 days, range picker inside)
                            --to sets the end day; --out sets the file path
  ulens serve [options]     run a localhost backend; UI polls it every minute
  ulens pages [options]     write a data-free GitHub Pages UI shell

Dimensions:
  day        per day (default)
  model      per model
  app        per app (claude / opencode / codex ...)
  session    per opencode session (joins titles)
  day+model  day x model matrix
  day+app    day x app matrix

Options:
  --from YYYY-MM-DD    start date (inclusive)
  --to YYYY-MM-DD      end date (inclusive)
  --app NAME           filter by app
  --metric NAME        sort metric: real|fresh|context|output|cost (default real)
  --limit N            show top N rows
  --db PATH            cc-switch db override (default ~/.cc-switch/cc-switch.db)
  --port N             local server port (default 4782)
  --origin URL         allowed hosted UI origin, e.g. https://user.github.io
  --api-base URL       local API URL embedded by pages (default http://127.0.0.1:4782)
  --out PATH           output file for html / pages
  -h, --help           this help

Metrics shown per row (columns):
  real    = in + out + cacheRead + cacheCreation   (cc-switch UI口径)
  fresh   = in + out                               (去缓存幻影)
  context = in + cacheRead                         (上下文搬运量)
  output  = generated tokens
  cost    = estimated USD (local pricing, not upstream billing)`;

function parseArgs(argv) {
  const opts = { dim: 'day', metric: 'real' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--app') opts.app = argv[++i];
    else if (a === '--metric') opts.metric = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--db') opts.db = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--origin') opts.origin = argv[++i];
    else if (a === '--api-base') opts.apiBase = argv[++i];
    else if (!a.startsWith('--')) opts.dim = a;
    else { console.error(`unknown option: ${a}`); process.exit(1); }
  }
  return opts;
}

async function readRows(filters) {
  const dbPath = await resolveCCSwitchDb(filters.db);
  const db = await openReadOnly(dbPath);
  try {
    return loadRows(db, filters);
  } finally {
    await dispose(db);
  }
}

async function writeHtmlReport(opts) {
  const { buildReport, reportWindow, REPORT_WINDOW_DAYS } = await import('../lib/report.js');
  const { start, end, clamped } = reportWindow(opts);
  if (clamped) console.error(`note: html report keeps at most ${REPORT_WINDOW_DAYS} days, using ${start} ~ ${end}`);

  const rows = await readRows({ ...opts, from: start, to: end });
  if (!rows.length) { console.log(`no data between ${start} and ${end}`); return; }

  const sessions = await withSessionTitles(aggregate(rows, 'session'), () => openReadOnly(OPENCODE_DB));
  const titles = new Map(sessions.filter(s => s.title).map(s => [s.key, s.title]));
  const html = await buildReport(rows, { start, end, titles });

  const { writeFile } = await import('node:fs/promises');
  const out = opts.out ?? 'cc-usage-report.html';
  await writeFile(out, html);
  console.log(`report written: ${out} (${start} ~ ${end}, ${rows.length} source rows)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!METRICS[opts.metric]) { console.error(`unknown metric: ${opts.metric}`); process.exit(1); }

  if (opts.dim === 'serve') return runServer(opts);
  if (opts.dim === 'pages') return writePagesShell(opts);
  if (opts.dim === 'html') return writeHtmlReport(opts);

  const rows = await readRows(opts);
  if (!rows.length) { console.log('no data for the given filters'); return; }

  let agg = aggregate(rows, opts.dim, opts);
  if (opts.dim === 'session') {
    agg = await withSessionTitles(agg, () => openReadOnly(OPENCODE_DB));
    opts.showTitle = opts.showTitle ?? true;
  }
  console.log(renderTable(agg, opts));
}

async function runServer(opts) {
  const { startServer, DEFAULT_PORT } = await import('../lib/server.js');
  const port = opts.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535');
  const { server, dbPath, trustedOrigin } = await startServer({ port, origin: opts.origin, db: opts.db });
  console.log(`Usage Lens: http://127.0.0.1:${server.address().port}/`);
  console.log(`Database:   ${dbPath}`);
  console.log(`Auto-refresh: every 60 seconds${trustedOrigin ? `; CORS origin: ${trustedOrigin}` : ''}`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function writePagesShell(opts) {
  const { buildLivePage, DEFAULT_API_BASE } = await import('../lib/report.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const out = opts.out ?? 'docs/index.html';
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const html = await buildLivePage({ apiBase });
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, html);
  console.log(`data-free Pages UI written: ${out}`);
  console.log(`It reads data from ${apiBase}/api/data; start local backend with: ulens serve --origin https://<user>.github.io`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
