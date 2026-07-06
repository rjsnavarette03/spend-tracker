# SpendTracker

A personal budget, spending and income tracker. This repo contains **two apps** that share the same UI and data model:

- **Desktop** (this folder) — an offline Electron app; all data stays on your machine in a local SQLite database. No account, no server, no telemetry.
- **Web** ([`web/`](web/)) — a multi-user web app (React + PHP/MySQL) with email/password and Google sign-in, built for Hostinger shared hosting. **Live at [budgettracker.rjsnavarette.com](https://budgettracker.rjsnavarette.com).**

![Stack](https://img.shields.io/badge/desktop-Electron%20%2B%20React%20%2B%20TS%20%2B%20SQLite-34d399)
![Stack](https://img.shields.io/badge/web-React%20%2B%20PHP%20%2B%20MySQL-6366f1)

Both apps store **money as integer cents** end to end, use `YYYY-MM-DD` / `YYYY-MM` date strings, and share the same four screens (Dashboard, Transactions, Budgets, Categories).

> Working in this repo with Claude Code or another agent? Start with **[CLAUDE.md](CLAUDE.md)** — it maps both apps, their commands, and the non-obvious gotchas.

## Repository layout

```
.                     ← desktop app (Electron + React)
├─ electron/          main process + sql.js data layer + typed IPC
├─ src/               React renderer (shared UI)
├─ shared/types.ts    main↔renderer contract
├─ scripts/           dev / build / icon / smoke tooling
└─ web/               ← web app (self-contained)
   ├─ src/            React SPA (ported from the desktop UI) + auth screens
   ├─ server/         PHP 8 JSON API + MySQL/SQLite schema
   ├─ test/           end-to-end API test suite
   ├─ README.md       web dev guide
   └─ DEPLOY.md       step-by-step Hostinger deployment
```

The two apps have separate `package.json` files and separate builds. The rest of this README covers the **desktop** app; see [web/README.md](web/README.md) for the web app.

## Features

- **Dashboard** — monthly income / expenses / net, savings rate, budget usage, 6-month income-vs-expense trend chart, spending-by-category donut, budget snapshot, recent transactions.
- **Transactions** — add / edit / delete income and expenses, filter by month, type, category and free-text search, per-filter totals, CSV export (Excel-friendly).
- **Budgets** — set a monthly limit per expense category, inline editing, spent / remaining / progress with over-budget highlighting, one-click "copy last month".
- **Categories** — separate income and expense categories with colors; deleting a category keeps its transactions (they become *Uncategorized*).

## Tech stack

| Layer | Choice |
| --- | --- |
| UI | React 18 + TypeScript, bundled with Vite |
| Desktop shell | Electron (context isolation + sandboxed renderer, typed IPC bridge) |
| Backend | Node.js in the Electron main process |
| Database | SQLite via [sql.js](https://github.com/sql-js/sql.js) (WebAssembly — no native modules to compile) |
| Packaging | electron-builder (NSIS installer + portable exe) |

The database file lives at `%APPDATA%/SpendTracker/spend-tracker.sqlite` and is written atomically after every mutation.

## Development

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload for the UI
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Typecheck (renderer + main), build the renderer, bundle main/preload with esbuild |
| `npm run smoke` | Headless end-to-end test: DB round trip, FK actions, React mount, IPC bridge |
| `npm run start` | Run the production build in Electron |
| `npm run icon` | Regenerate `buildResources/icon.ico` (pure-Node PNG/ICO encoder, no image deps) |
| `npm run dist` | Full build + icon + `electron-builder --win` |

## Building the Windows executables

```bash
npm run dist
```

Outputs in `release/`:

- `SpendTracker-Setup-1.0.0.exe` — NSIS installer (per-user, choosable install dir, Start-menu + desktop shortcut)
- `SpendTracker-1.0.0-portable.exe` — single-file portable build, no install needed
- `release/win-unpacked/SpendTracker.exe` — raw unpacked app

The binaries are unsigned, so Windows SmartScreen may show a "More info → Run anyway" prompt on first launch.

## Architecture notes

- `electron/main.ts` — window management, IPC handlers, `--smoke-test` mode.
- `electron/db.ts` — the whole data layer: schema, seeding, validation, queries, reports. sql.js keeps the DB in memory; every mutation exports it and atomically replaces the file on disk. (Note: `export()` reopens the connection, so `PRAGMA foreign_keys` is re-applied after each persist and `last_insert_rowid()` is read before persisting.)
- `electron/preload.ts` — exposes the typed `window.api` bridge (`shared/types.ts` is the single source of truth for the contract).
- `src/` — React renderer; pages fetch through `window.api` only, no Node access.
- Money is stored as **integer cents** end to end; formatting happens only at the UI edge.
