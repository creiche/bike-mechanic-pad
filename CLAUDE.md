# Project Guardrails: bike-mechanic-pad

## 1. Project Ethos & Licensing
- This is a free, local-first, offline-first open-source digital clipboard web app for solo bike mechanics under **GPLv3**.
- Do NOT add external cloud dependencies, hosted API calls, tracking/telemetry, or remote database services.

## 2. Tech Stack & Architecture
- **Framework:** SvelteKit (TypeScript) with Tailwind CSS.
- **Database:** Local SQLite running inside `@sqlite.org/sqlite-wasm` with OPFS (Origin Private File System) persistence.
- **Local-First ID Standard:** ALWAYS use `id TEXT PRIMARY KEY` across all tables. IDs must be generated client-side using Web Crypto (`crypto.randomUUID()`). Do NOT use auto-incrementing `INTEGER PRIMARY KEY`.
  - **Sole exception:** `sync_outbox.seq INTEGER PRIMARY KEY AUTOINCREMENT`. It is a device-local, gap-tolerant ordering cursor for the sync protocol (push/pull cursors compare `seq`), which random UUIDs cannot provide. The row's identity is still the client-generated `id TEXT UNIQUE NOT NULL`; `seq` is never an entity key, never sent as one, and never used in foreign keys. Any other table needing a counter must justify it here first.
- **Data Integrity:** Store all currency amounts as **integers in cents** (`unit_price_cents`, `total_cents`). NEVER use floating-point numbers for money calculations or storage.
- **Foreign Keys & Naming:** Always enable `PRAGMA foreign_keys = ON;` and use `ON DELETE CASCADE` for customer -> bike -> work order relationships. Use `brand` (not `make`) for bike models.
- **Repository Pattern & Sync:** All database writes MUST go through repository transactions and explicitly call `notifyLocalWrite()`. Outbox entities must maintain last-write-wins per record and be fully supported in snapshot export/import.
- **Component Wear Tracking:** Component service logging is strictly date-based (local ISO date string `YYYY-MM-DD`). Updating component service dates upon work order completion MUST happen inside the same database transaction as the status change.

## 3. Learning & Development Strategy
- Focus on step-by-step modular code. Avoid massive monolith files.
- Include clear TypeScript interfaces and explanatory comments for database operations so the codebase remains readable and easy to learn from.
- UI styling must prioritize high-contrast dark mode suitable for a shop repair stand / tablet environment.

## 4. Token & Context Optimization Rules
- **Concise Tool Usage:** Keep shell command outputs minimal. Avoid running `npm test` or `playwright` without specific file filters when debugging a single failing test.
- **Ignore Bulky Directories:** Do NOT read, search, or inspect files inside `node_modules/`, `.svelte-kit/`, `dist/`, `build/`, `playwright-report/`, or `test-results/`.
- **Targeted File Reads:** Read only the specific functions or files required for the current task. Do NOT read entire large files or fetch multi-file context unless strictly necessary.
- **Log Suppression:** When running tests or build scripts, use flags that minimize verbose output (e.g., `npm test -- --reporter=dot` or running single Playwright specs).
- **No Refactoring Unrelated Code:** Stick strictly to the scope of the assigned ticket. Do not clean up or rewrite surrounding code outside the active ticket requirements.

# Agent Verification & Workflow Requirements
- Always verify changes with `npm run check` (`svelte-check`), `npm test`, and `npx playwright test` before declaring a task complete.
- Do not mark a ticket complete if there are type errors, failing tests, or unhandled promise rejections.
- Prefer deep architectural analysis and complete code modifications over minimal patches.
- For complex code changes or multi-file edits, explicitly reason through step-by-step implementations.