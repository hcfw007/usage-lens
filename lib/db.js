import { DatabaseSync } from 'node:sqlite';
import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = homedir();
export const CC_SWITCH_HOME = process.env.CC_SWITCH_HOME || join(HOME, '.cc-switch');
export const CC_SWITCH_DB = process.env.CC_SWITCH_DB || join(CC_SWITCH_HOME, 'cc-switch.db');
export const OPENCODE_DB = process.env.OPENCODE_DB || join(HOME, '.local', 'share', 'opencode', 'opencode.db');

/** Resolve an explicit path first, otherwise probe common cc-switch locations. */
export async function resolveCCSwitchDb(explicitPath) {
  const candidates = explicitPath || process.env.CC_SWITCH_DB
    ? [explicitPath || process.env.CC_SWITCH_DB]
    : [
        join(process.env.CC_SWITCH_HOME || join(HOME, '.cc-switch'), 'cc-switch.db'),
        ...(process.platform === 'win32' && process.env.USERPROFILE
          ? [join(process.env.USERPROFILE, '.cc-switch', 'cc-switch.db')]
          : []),
        ...(process.platform === 'linux' ? [join(HOME, '.config', 'cc-switch', 'cc-switch.db')] : []),
        ...(process.platform === 'darwin'
          ? [join(HOME, 'Library', 'Application Support', 'com.ccswitch.desktop', 'cc-switch.db')]
          : []),
      ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next conventional location.
    }
  }
  throw new Error(
    `cc-switch database not found. Set CC_SWITCH_DB=/path/to/cc-switch.db, ` +
    `CC_SWITCH_HOME=/path/to/.cc-switch, or pass --db PATH. Checked: ${candidates.join(', ')}`,
  );
}

/**
 * Open a SQLite database read-only. cc-switch writes every ~60s and uses
 * journal mode `delete`; if the file is locked we fall back to a temp copy.
 */
export async function openReadOnly(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    if (!/unable to open|locked|busy/i.test(String(err))) throw err;
    const dir = await mkdtemp(join(tmpdir(), 'ccusage-'));
    const copy = join(dir, 'snapshot.db');
    await cp(dbPath, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    db._tempDir = dir; // caller may cleanup via dispose()
    return db;
  }
}

export async function dispose(db) {
  db.close();
  if (db._tempDir) await rm(db._tempDir, { recursive: true, force: true });
}

/**
 * Unified request-level rows across both storage eras:
 *  - proxy_request_logs     (>= 2026-09-16, per-request, has session_id)
 *  - usage_daily_rollups    (<= 2026-09-15, per day/model, no session)
 * Column shape returned: { date, app, model, session, requests,
 *   input, output, cacheRead, cacheCreation, cost }
 */
export function loadRows(db, { from, to, app } = {}) {
  const conds = [];
  const params = [];
  if (from) { conds.push('date >= ?'); params.push(from); }
  if (to) { conds.push('date <= ?'); params.push(to); }
  if (app && app !== 'all') { conds.push('app_type = ?'); params.push(app); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const detail = db.prepare(`
    SELECT date(created_at, 'unixepoch', 'localtime') AS date,
           app_type AS app, model,
           COALESCE(session_id, '') AS session,
           COUNT(*) AS requests,
           SUM(input_tokens) AS input,
           SUM(output_tokens) AS output,
           SUM(cache_read_tokens) AS cacheRead,
           SUM(cache_creation_tokens) AS cacheCreation,
           SUM(CAST(total_cost_usd AS REAL)) AS cost
    FROM proxy_request_logs ${where}
    GROUP BY date, app, model, session
  `).all(...params);

  // rollups: reuse the same filters, session is not available pre-09-16
  const roll = db.prepare(`
    SELECT date, app_type AS app, model,
           '' AS session,
           SUM(request_count) AS requests,
           SUM(input_tokens) AS input,
           SUM(output_tokens) AS output,
           SUM(cache_read_tokens) AS cacheRead,
           SUM(cache_creation_tokens) AS cacheCreation,
           SUM(CAST(total_cost_usd AS REAL)) AS cost
    FROM usage_daily_rollups ${where}
    GROUP BY date, app, model
  `).all(...params);

  return [...detail, ...roll];
}

/** Earliest date with data across detail logs and daily rollups (null when the db is empty). */
export function loadEarliestDate(db) {
  const detail = db.prepare(`
    SELECT MIN(date(created_at, 'unixepoch', 'localtime')) AS min_date FROM proxy_request_logs
  `).get();
  const roll = db.prepare('SELECT MIN(date) AS min_date FROM usage_daily_rollups').get();
  const candidates = [detail?.min_date, roll?.min_date].filter(Boolean).sort();
  return candidates[0] ?? null;
}

/**
 * Request-level aggregates grouped into 30-minute slots for one local day (`date`)
 * or an inclusive range (`from`/`to`). Rows carry their own `date` so callers can
 * keep several days at once. Session is intentionally not grouped: the intraday
 * chart is aggregate-only, and dropping it keeps the payload small.
 * Only `proxy_request_logs` has slot detail; rollup-only days yield no rows.
 */
export function loadIntradayRows(db, { date, from, to } = {}) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const startDay = date ?? from;
  const endDay = date ?? to ?? from;
  if (!DAY.test(startDay || '') || !DAY.test(endDay || '')) return [];
  const start = new Date(`${startDay}T00:00:00`);
  const end = new Date(`${endDay}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  end.setDate(end.getDate() + 1);
  const slot = `CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER) * 2 +
    CASE WHEN CAST(strftime('%M', created_at, 'unixepoch', 'localtime') AS INTEGER) >= 30 THEN 1 ELSE 0 END`;

  return db.prepare(`
    SELECT date(created_at, 'unixepoch', 'localtime') AS date,
           ${slot} AS slot, app_type AS app, model,
           COUNT(*) AS requests,
           SUM(input_tokens) AS input,
           SUM(output_tokens) AS output,
           SUM(cache_read_tokens) AS cacheRead,
           SUM(cache_creation_tokens) AS cacheCreation,
           SUM(CAST(total_cost_usd AS REAL)) AS cost
    FROM proxy_request_logs
    WHERE created_at >= ? AND created_at < ?
    GROUP BY date, slot, app, model
    ORDER BY date, slot
  `).all(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
}
