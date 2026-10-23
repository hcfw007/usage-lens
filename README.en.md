# usage-lens

[中文](README.md) | **English**

Usage Lens is a zero-dependency CLI and local web UI for analyzing usage recorded in cc-switch's SQLite database.

## Why

Some model providers and relays do not report cache read/write usage. The same long-context request can appear as cached input on one route and ordinary input on another. Comparing a single total can confuse reporting differences with actual workload changes.

Usage Lens shows several token metrics side by side, calculates cache hit rate excluding records with unreported cache usage, and flags those records. It does not invent missing cache data or replace the provider's bill.

## Requirements and install

- Node.js >= 22.5 (`node:sqlite` is used; no third-party runtime dependencies)

```bash
npm link             # optional: install the `ulens` command globally
# or run directly: node bin/cli.js
```

## HTML snapshot

```bash
ulens html                       # last 30 days -> ./cc-usage-report.html
ulens html --out ~/usage.html
ulens html --all                 # include every day readable in the database
```

This creates a self-contained HTML snapshot with its data embedded. Open it directly in a browser. It supports Today / Last 7 / 14 / 30 / 60 days, All (from the earliest day readable in the database), custom dates, and metric switching.
When Today is selected, the chart uses 30-minute buckets (48 slots); longer ranges remain grouped by day.
Clicking a bar in a multi-day view drills into that day's 30-minute view; use "返回每日视图" to go back.
Days that only have daily rollups (no request-level detail) show a notice instead.

## Live local dashboard

```bash
npm run serve                    # run in foreground at http://127.0.0.1:4782
npm run serve -- --port 4783     # use a custom port
npm run serve:background         # start in the background
npm run serve:stop               # stop the background server
ulens serve                      # http://127.0.0.1:4782
ulens serve --db /path/to/cc-switch.db
```

The server runs in the foreground so logs stay visible; press Ctrl+C to stop it.
Background mode stores its PID and log at `~/.usage-lens/serve.pid` and `~/.usage-lens/serve.log`.
Pass a custom port with `npm run serve:background -- --port 4783`; the stop command sends SIGTERM.

The HTML template is stored in this repository; usage data is fetched from the same-origin local backend and is never uploaded. The server binds only to `127.0.0.1`. The page refreshes every five minutes and has a manual refresh button. The default range is 30 days, with quick presets for Today / Last 7 / 14 / 30 / 60 days and All (from the earliest day readable in the database). Model, session, and app rankings are collapsible and start collapsed.
Today is charted in 30-minute intervals; longer ranges are grouped by day.
Multi-day views also support clicking a bar to open that day's intraday view; rollup-only days explain why detail is unavailable.

## Selecting the cc-switch database

Database selection precedence is: `--db` > `CC_SWITCH_DB` > `CC_SWITCH_HOME` > automatic detection. `CC_SWITCH_DB` is the full database file path; `CC_SWITCH_HOME` is the directory containing `cc-switch.db`.

```bash
ulens serve --db /absolute/path/cc-switch.db
export CC_SWITCH_DB=/absolute/path/cc-switch.db
export CC_SWITCH_HOME=/absolute/path/.cc-switch
```

These environment variables apply to both CLI queries and the local backend. On startup, the backend prints the resolved database path. Automatic detection checks `~/.cc-switch/cc-switch.db` and common config locations. On Windows it also checks `%USERPROFILE%\.cc-switch\cc-switch.db`, the default cc-switch data path. If cc-switch uses a custom data directory, set `CC_SWITCH_DB` or `CC_SWITCH_HOME` explicitly.

## CLI examples

```bash
ulens day --from 2026-10-08
ulens model --from 2026-10-13 --metric fresh
ulens session --from 2026-10-13 --metric cost --limit 10
```

Dimensions: `day`, `model`, `app`, `session`, `day+model`, and `day+app`.

| Metric | Formula | Meaning |
|---|---|---|
| `real` | input + output + cache read + cache write | cc-switch UI total |
| `fresh` | input + output | Input and output excluding cache fields |
| `context` | input + cache read | Context sent to the model, cache-independent |
| `output` | output | Generated tokens |
| `cost` | Local model pricing estimate | Not the upstream bill |

## Data sources

Usage Lens opens `~/.cc-switch/cc-switch.db` read-only and combines `proxy_request_logs` (request-level detail) with `usage_daily_rollups` (historical daily aggregates). Session titles are optionally read from OpenCode's local database. If cc-switch holds a write lock, the reader falls back to a temporary copy.
