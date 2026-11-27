import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';

import { createBareDb, createOpencodeDb, createUsageDb, localEpoch, makeTempDir } from './helpers/fixtures.js';
import { request } from './helpers/http.js';

let dir;
let cleanup;
let startServer;
let DEFAULT_PORT;
let mainServer;
let brokenServer;
let usageDbPath;
let bareDbPath;

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

before(async () => {
  ({ dir, cleanup } = await makeTempDir());
  usageDbPath = join(dir, 'cc-switch.db');
  bareDbPath = join(dir, 'bare.db');

  createUsageDb(usageDbPath, {
    detail: [
      { at: localEpoch(2026, 10, 13, 12, 15), app: 'claude', model: 'model-a', session: 'ses_abc',
        input: 100, output: 10, cacheRead: 50, cacheCreation: 5, cost: 0.5 },
      { at: localEpoch(2026, 10, 14, 8, 0), app: 'opencode', model: 'model-b',
        input: 5, output: 5, cost: 0.01 },
    ],
    rollups: [
      { date: '2026-10-12', app: 'claude', model: 'model-a', requests: 7,
        input: 700, output: 70, cacheRead: 7000, cacheCreation: 70, cost: 1.25 },
    ],
  });
  createBareDb(bareDbPath);
  createOpencodeDb(join(dir, 'opencode.db'), [{ id: 'ses_abc', title: 'My session' }]);

  // OPENCODE_DB is captured when lib/db.js first loads, so set it before importing.
  process.env.OPENCODE_DB = join(dir, 'opencode.db');
  ({ startServer, DEFAULT_PORT } = await import('../lib/server.js'));
  mainServer = await startServer({ port: 0, db: usageDbPath });
  brokenServer = await startServer({ port: 0, db: bareDbPath });
});

after(async () => {
  await Promise.all([mainServer, brokenServer].map(instance => closeServer(instance.server)));
  await cleanup();
});

test('startServer binds a random port and reports the resolved database', () => {
  assert.equal(DEFAULT_PORT, 4782);
  assert.ok(Number.isInteger(mainServer.port) && mainServer.port > 0);
  assert.notEqual(mainServer.port, DEFAULT_PORT);
  assert.equal(mainServer.dbPath, usageDbPath);
});

test('serves the live page at / with the live flag injected', async () => {
  const res = await request(mainServer.port, { path: '/' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // buildLivePage consumes the placeholder comment: the flag flips and the data
  // placeholder stays in place for the client-side fetch.
  assert.ok(res.body.includes('const LIVE_MODE = true;'));
  assert.ok(res.body.includes('let DATA = /*__DATA__*/null;'));
});

test('serves the same page at /index.html', async () => {
  const res = await request(mainServer.port, { path: '/index.html' });
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('const LIVE_MODE = true;'));
});

test('answers HEAD / with headers but no body', async () => {
  const res = await request(mainServer.port, { path: '/', method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.body, '');
});

test('serves aggregated JSON at /api/data', async () => {
  const res = await request(mainServer.port, { path: '/api/data' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const data = JSON.parse(res.body);
  assert.equal(data.start, '2026-10-12'); // earliest data day, not the 30-day fallback
  assert.match(data.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.end >= '2026-10-14');
  assert.equal(data.rows.length, 3); // 2 detail groups + 1 rollup row
  assert.deepEqual([...data.apps].sort(), ['claude', 'opencode']);
  assert.ok(data.sessions.includes('ses_abc'));
  assert.equal(data.titles[data.sessions.indexOf('ses_abc')], 'My session');
  assert.deepEqual(data.intraday.map(r => r[0]).sort(), ['2026-10-13', '2026-10-14']);
});

test('answers HEAD /api/data with an empty body', async () => {
  const res = await request(mainServer.port, { path: '/api/data', method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
});

test('returns empty rows for a database without usage', async () => {
  const emptyDbPath = join(dir, 'empty.db');
  createUsageDb(emptyDbPath);
  const instance = await startServer({ port: 0, db: emptyDbPath });
  try {
    const res = await request(instance.port, { path: '/api/data' });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.deepEqual(data.rows, []);
    assert.deepEqual(data.intraday, []);
  } finally {
    await closeServer(instance.server);
  }
});

test('returns 503 JSON when the database cannot be queried', async () => {
  const res = await request(brokenServer.port, { path: '/api/data' });
  assert.equal(res.status, 503);
  const data = JSON.parse(res.body);
  assert.match(data.error, /no such table/);
});

test('returns 404 for unknown paths', async () => {
  const res = await request(mainServer.port, { path: '/nope' });
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.equal(res.body, 'Not found');
});

test('rejects non-local Host headers', async () => {
  const res = await request(mainServer.port, { path: '/', headers: { Host: 'evil.example.com' } });
  assert.equal(res.status, 403);
  assert.equal(res.body, 'Forbidden host');
});

test('rejects requests that carry no Host header at all', async () => {
  // HTTP/1.0 has no Host requirement, so a raw request can omit it entirely.
  const response = await new Promise((resolve, reject) => {
    const socket = connect(mainServer.port, '127.0.0.1', () => {
      socket.write('GET / HTTP/1.0\r\n\r\n');
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(response, /403 Forbidden/);
  assert.ok(response.includes('Forbidden host'));
});

test('accepts localhost Host headers', async () => {
  const res = await request(mainServer.port, {
    path: '/',
    headers: { Host: `localhost:${mainServer.port}` },
  });
  assert.equal(res.status, 200);
});

test('rejects methods other than GET and HEAD', async () => {
  const res = await request(mainServer.port, { path: '/', method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  assert.equal(res.body, 'Method not allowed');
});

test('rejects cross-origin Origin headers', async () => {
  const res = await request(mainServer.port, {
    path: '/',
    headers: { Origin: 'http://evil.example.com' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body, 'Localhost-only origin');
});

test('allows an Origin matching the request host', async () => {
  const res = await request(mainServer.port, {
    path: '/',
    headers: { Origin: `http://127.0.0.1:${mainServer.port}` },
  });
  assert.equal(res.status, 200);
});
