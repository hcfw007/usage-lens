# AGENTS.md

Zero-dependency ESM Node CLI + local dashboard that reads cc-switch's SQLite usage DB.
No build step, no bundler, no third-party runtime deps — `node:` stdlib only.

## Commands

```bash
node bin/cli.js day --limit 5               # npm start -- day --limit 5
node bin/cli.js model --from 2026-10-13 --metric fresh
node bin/cli.js session --metric cost --limit 10
node bin/cli.js html --out /tmp/usage.html  # static, self-contained
node bin/cli.js serve --port 4783           # localhost UI
npm link                                    # only way to get `ulens`
```

There is **no test, lint, typecheck, or build script** and `.github/workflows` is empty.
Verify changes by running the CLI/server against a real cc-switch DB (or point
`CC_SWITCH_DB` / `--db` at a fixture copy). DB path precedence: `--db` > `CC_SWITCH_DB` >
`CC_SWITCH_HOME` > platform auto-detect.

Node version gotcha: `node:sqlite` is unflagged only from **v22.13 / v23.4**. On
22.5–22.12 you must run `node --experimental-sqlite ...` even though `engines` says >=22.5.

## Module boundaries

| File | Owns |
|---|---|
| `bin/cli.js` | arg parsing, command dispatch (`html` / `serve` / dimensions), no data logic |
| `lib/db.js` | DB path resolution, read-only open + temp-snapshot fallback, **all SQL** |
| `lib/aggregate.js` | metric + dimension definitions, opencode session-title join |
| `lib/render.js` | terminal table only (keeps its own copies of the metric formulas) |
| `lib/report.js` | compact payload builder, template injection, live-page shell |
| `lib/report.html` | the only UI; shared by static export and live server; inline CSS/JS |
| `lib/server.js` | localhost HTTP routes `/` and `/api/data` |

## Data quirks (silently wrong numbers if ignored)

- Dates are **local time**: `date(created_at, 'unixepoch', 'localtime')`. Any new query must
  use the same expression, or day boundaries shift.
- Two storage eras are merged: `proxy_request_logs` (request-level, `session_id`, intraday) and
  `usage_daily_rollups` (day-level, no session). Code does **not** hardcode the cutover date — it
  just unions both tables, so the boundary differs per machine (locally rollups end 2026-09-20,
  detail starts 2026-09-21). Session and 30-minute views are empty before that point — degrade to
  empty, never invent rows.
- `loadRows` applies the same `WHERE` + param list to both tables. When adding a filter, make
  sure both queries still accept the same params (`usage_daily_rollups` has no `session_id`).
- Session titles come from `session_v2` in `opencode.db`: exact id match, then 20-char prefix.
  Must stay best-effort/non-fatal.
- "Cache unreported" = `input > 0 && cacheRead === 0 && cacheCreation === 0`. Treating such rows
  as 0% cache hit is a correctness bug — excluding them is the point of the tool.

## Changing a metric

Formulas are duplicated across layers; keep them identical:
`lib/aggregate.js` (`METRICS`), `lib/render.js` (`HEADERS` + local accessors),
`lib/report.html` (client `METRICS` incl. Chinese label/formula/desc/caveat), plus the
`USAGE` text in `bin/cli.js`. (`METRIC_UNITS` is currently unused.)

Do not "fix":
- `real` deliberately adds cache read + write to input + output to mirror cc-switch's UI total.
- `cost` is a local pricing estimate, never upstream billing.

## Template / payload gotchas

- `lib/report.html` is string-patched: keep exactly one `/*__DATA__*/null` and one
  `/*__LIVE__*/false` placeholder.
- Embedded JSON escapes `<` as `\u003c` on purpose (safe inside `<script>`); keep it.
- Payload rows are dictionary-encoded arrays (dates/apps/models/sessions deduped). Changing the
  array shape requires updating `decodeRows` / `decodeIntraday` in the template.
- `intraday` is `[date, slot, app, model, ...]` for the whole loaded range (no session). The UI
  drills into a day when `from === to` **and** that day has request-level rows; rollup-only days
  must show a toast (never re-render the report) rather than an empty chart. The static report
  needs all days embedded — do not make intraday lazy-loadable if you want click-to-drill offline.
- Keep `isUnreported` a hoisted `function`: static reports call `decodeIntraday` at top level,
  before later `const` declarations are initialized.
- Payload stays at day × app × model × session so the browser can re-range client-side. Do not
  pre-aggregate beyond that; the page offers 1/7/14/30/60/all presets from the same JSON.

## Server constraints

Binds `127.0.0.1` only, rejects non-local `Host`/`Origin` and non-GET. README promises usage data
never leaves the machine: no telemetry, external fetches, or write endpoints. Each `/api/data`
re-reads the DB on purpose (no data caching).

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`), one focused change each.
- User-facing changes must update **both** `README.md` (Chinese) and `README.en.md`.
- `cc-usage-report.html` at the repo root is a generated artifact and gitignored — never commit it.
