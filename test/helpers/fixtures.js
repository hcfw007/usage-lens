import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Unix seconds for a local wall-clock time — matches db.js's 'localtime' date expressions. */
export function localEpoch(year, month, day, hour = 12, minute = 0) {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000);
}

/**
 * Create a cc-switch-shaped usage database.
 * detail:  { at, app, model, session, input, output, cacheRead, cacheCreation, cost }
 * rollups: { date, app, model, requests, input, output, cacheRead, cacheCreation, cost }
 */
export function createUsageDb(dbPath, { detail = [], rollups = [] } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE proxy_request_logs (
      created_at INTEGER, app_type TEXT, model TEXT, session_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER, total_cost_usd REAL
    );
    CREATE TABLE usage_daily_rollups (
      date TEXT, app_type TEXT, model TEXT, request_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER, total_cost_usd REAL
    );
  `);
  const insertDetail = db.prepare(`
    INSERT INTO proxy_request_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of detail) {
    insertDetail.run(
      r.at, r.app, r.model, r.session ?? '',
      r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheCreation ?? 0, r.cost ?? 0,
    );
  }
  const insertRollup = db.prepare(`
    INSERT INTO usage_daily_rollups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rollups) {
    insertRollup.run(
      r.date, r.app, r.model, r.requests ?? 1,
      r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheCreation ?? 0, r.cost ?? 0,
    );
  }
  db.close();
}

/** Create a SQLite file without the cc-switch usage tables (schema mismatch). */
export function createBareDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE unrelated (x INTEGER)');
  db.close();
}

/** Create a minimal opencode database with session titles. */
export function createOpencodeDb(dbPath, sessions = []) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_v2 (id TEXT, title TEXT)');
  const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?)');
  for (const { id, title } of sessions) insert.run(id, title);
  db.close();
}

/** Fresh temp directory, removed by the returned cleanup function. */
export async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'usage-lens-test-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { dir, cleanup };
}
