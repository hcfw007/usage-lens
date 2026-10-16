const M = 1_000_000;

function fmtTokens(n) {
  if (n == null) return '-';
  if (n >= 100 * M) return (n / M).toFixed(0) + 'M';
  if (n >= M) return (n / M).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function fmtUsd(n) {
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

function pad(s, w, right = false) {
  s = String(s);
  return right ? s.padStart(w) : s.padEnd(w);
}

const HEADERS = ['key', 'reqs', 'real', 'fresh', 'context', 'output', 'cost', 'extra'];

export function renderTable(rows, { metric, dim, showTitle }) {
  const widths = {};
  for (const h of HEADERS) widths[h] = h.length;

  const lines = rows.map(r => {
    const key = showTitle && r.title ? `${r.key}  ${r.title}`.slice(0, 72) : r.key;
    return {
      key,
      reqs: String(r.requests),
      real: fmtTokens(METRICS_REAL(r)),
      fresh: fmtTokens(METRICS_FRESH(r)),
      context: fmtTokens(METRICS_CONTEXT(r)),
      output: fmtTokens(r.output),
      cost: fmtUsd(r.cost),
      extra: cacheHint(r),
    };
  });

  for (const l of lines) for (const h of HEADERS) widths[h] = Math.max(widths[h], l[h].length);

  const sep = '-'.repeat(HEADERS.reduce((a, h) => a + widths[h] + 2, 0));
  const head = HEADERS.map(h => pad(h, widths[h], h !== 'key' && h !== 'extra')).join('  ');
  const body = lines.map(l => HEADERS.map(h => pad(l[h], widths[h], h !== 'key' && h !== 'extra')).join('  '));
  const note = `metric=${metric} dim=${dim}  (tokens in M/k; real=in+out+cache, fresh=in+out, context=in+cacheRead)`;
  return [note, sep, head, sep, ...body, sep].join('\n');
}

// small local accessors to avoid importing aggregate.js here
const METRICS_REAL = r => r.input + r.output + r.cacheRead + r.cacheCreation;
const METRICS_FRESH = r => r.input + r.output;
const METRICS_CONTEXT = r => r.input + r.cacheRead;

function cacheHint(r) {
  const total = r.input + r.output + r.cacheRead + r.cacheCreation;
  if (!total || !r.cacheRead) return '';
  const pct = Math.round((r.cacheRead / total) * 100);
  return `cache ${pct}%`;
}
