/**
 * Token accounting metrics (the whole point of this tool):
 *  real    — cc-switch UI default: input+output+cacheRead+cacheCreation
 *  fresh   — de-cached: input+output (what actually entered/exited the model)
 *  context — how much context was carried: input+cacheRead
 *  output  — generated tokens only
 *  cost    — estimated USD
 */
export const METRICS = {
  real: r => r.input + r.output + r.cacheRead + r.cacheCreation,
  fresh: r => r.input + r.output,
  context: r => r.input + r.cacheRead,
  output: r => r.output,
  cost: r => r.cost,
};

export const METRIC_UNITS = {
  real: 'tokens', fresh: 'tokens', context: 'tokens', output: 'tokens', cost: 'usd',
};

const DIMENSIONS = {
  day: r => r.date,
  app: r => r.app,
  model: r => r.model,
  session: r => r.session || '(no session)',
  'day+model': r => `${r.date}  ${r.model}`,
  'day+app': r => `${r.date}  ${r.app}`,
};

/**
 * Aggregate rows by dimension. Returns [{ key, requests, input, output,
 * cacheRead, cacheCreation, cost }] sorted by the chosen metric (desc).
 */
export function aggregate(rows, dim, { metric = 'real', limit } = {}) {
  const keyOf = DIMENSIONS[dim];
  if (!keyOf) throw new Error(`unknown dimension: ${dim}`);
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    let acc = map.get(key);
    if (!acc) {
      acc = { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
      map.set(key, acc);
    }
    acc.requests += r.requests;
    acc.input += r.input;
    acc.output += r.output;
    acc.cacheRead += r.cacheRead;
    acc.cacheCreation += r.cacheCreation;
    acc.cost += r.cost;
  }
  const valueOf = METRICS[metric];
  if (!valueOf) throw new Error(`unknown metric: ${metric}`);
  const list = [...map.values()].sort((a, b) => valueOf(b) - valueOf(a));
  return limit ? list.slice(0, limit) : list;
}

/** Attach opencode session titles (best-effort; ignored if db missing). */
export async function withSessionTitles(rows, openDb) {
  const ids = rows.map(r => r.key).filter(k => k.startsWith('ses_'));
  if (!ids.length) return rows;
  let db;
  try {
    db = await openDb();
    const stmt = db.prepare('SELECT id, title FROM session_v2 WHERE id LIKE ?');
    for (const r of rows) {
      // cc-switch ids may be longer/shorter than opencode's — try full, then prefix
      const hit = stmt.get(r.key) || stmt.get(r.key.slice(0, 20) + '%');
      r.title = hit?.title ?? '';
    }
  } catch {
    // opencode db not readable — titles are optional
  } finally {
    if (db) db.close();
  }
  return rows;
}
