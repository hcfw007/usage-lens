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
```

This creates a self-contained HTML snapshot with its data embedded. Open it directly in a browser. It supports Today / Last 7 / 14 / 30 days, custom dates within the snapshot, and metric switching.
When Today is selected, the chart uses 30-minute buckets (48 slots); longer ranges remain grouped by day.

## Live local dashboard

```bash
ulens serve                      # http://127.0.0.1:4782
ulens serve --db /path/to/cc-switch.db
```

The HTML template is stored in this repository; usage data is fetched from the same-origin local backend and is never uploaded. The server binds only to `127.0.0.1`. The page refreshes every five minutes and has a manual refresh button. The default range is 30 days. Model, session, and app rankings are collapsible and start collapsed.
Today is charted in 30-minute intervals; longer ranges are grouped by day.

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
