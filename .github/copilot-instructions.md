# Project Guardrails: bike-mechanic-pad

## 1. Project Ethos & Licensing
- This is a free, local-first, offline-first open-source digital clipboard web app for solo bike mechanics under **GPLv3**.
- Do NOT add external cloud dependencies, hosted API calls, tracking/telemetry, or remote database services.

## 2. Tech Stack & Architecture
- **Framework:** SvelteKit (TypeScript) with Tailwind CSS.
- **Database:** Local SQLite running inside `@sqlite.org/sqlite-wasm` with OPFS (Origin Private File System) persistence.
- **Local-First ID Standard:** ALWAYS use `id TEXT PRIMARY KEY` across all tables. IDs must be generated client-side using Web Crypto (`crypto.randomUUID()`). Do NOT use auto-incrementing `INTEGER PRIMARY KEY`.
- **Data Integrity:** Store all currency amounts as **integers in cents** (`unit_price_cents`, `total_cents`) to avoid floating-point errors.
- **Foreign Keys:** Always enable `PRAGMA foreign_keys = ON;` and use `ON DELETE CASCADE` for customer -> bike -> work order relationships.

## 3. Learning & Development Strategy
- Focus on step-by-step modular code. Avoid massive monolith files.
- Include clear TypeScript interfaces and explanatory comments for database operations so the codebase remains readable and easy to learn from.
- UI styling must prioritize high-contrast dark mode suitable for a shop repair stand environment.