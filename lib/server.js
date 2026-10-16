import { createServer } from 'node:http';
import { openReadOnly, dispose, loadRows, loadIntradayRows, resolveCCSwitchDb, OPENCODE_DB } from './db.js';
import { aggregate, withSessionTitles } from './aggregate.js';
import { buildLivePage, buildReportData, reportWindow } from './report.js';

const DEFAULT_PORT = 4782;

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host || '');
}

async function currentData(dbPath) {
  const { start, end } = reportWindow({});
  const db = await openReadOnly(dbPath);
  let rows, intraday;
  try {
    rows = loadRows(db, { from: start, to: end });
    intraday = loadIntradayRows(db, { date: end });
  } finally {
    await dispose(db);
  }
  const sessions = await withSessionTitles(aggregate(rows, 'session'), () => openReadOnly(OPENCODE_DB));
  const titles = new Map(sessions.filter(s => s.title).map(s => [s.key, s.title]));
  return buildReportData(rows, { start, end, titles, intraday });
}

export async function startServer({ port = DEFAULT_PORT, db: explicitDb } = {}) {
  const dbPath = await resolveCCSwitchDb(explicitDb);
  const page = await buildLivePage();

  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!isLocalHost(host)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const requestOrigin = req.headers.origin || '';
    const localOrigin = `http://${host}`;
    if (requestOrigin && requestOrigin !== localOrigin) {
      return send(res, 403, 'text/plain; charset=utf-8', 'Localhost-only origin');
    }

    const pathname = new URL(req.url || '/', localOrigin).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : page);
    }
    if (pathname === '/api/data') {
      try {
        const data = await currentData(dbPath);
        return send(res, 200, 'application/json; charset=utf-8', req.method === 'HEAD' ? '' : JSON.stringify(data));
      } catch (error) {
        return send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
      }
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, dbPath };
}

export { DEFAULT_PORT };
