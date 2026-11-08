# Bike Mechanic Pad (`bike-mechanic-pad`)
> A free, local-first, offline-first digital clipboard for solo bike mechanics.
> **License:** GPLv3

---

## 1. Executive Summary & Vision

`bike-mechanic-pad` is a privacy-respecting, zero-telemetry web application designed for solo bike mechanics working on shop floors, at mobile repair rigs, or in home workshops. 

### Core Product Principles:
- **Local-First & Offline-First:** All customer, bike, and work order data lives on the user's device inside an SQLite database in OPFS (Origin Private File System). It requires zero internet connection to function.
- **Serverless Multi-Device Sync:** Mechanics can seamlessly switch between an iPhone on the shop floor, an iPad on the repair stand, and a desktop in the office throughout the day using standard consumer cloud storage (Dropbox, Google Drive, OneDrive) or private object storage (S3/R2/WebDAV) as a dumb drop-off relay.
- **Instant Master Takeover:** Any single device can act as the authoritative state or take over as master. Full database export/import options guarantee total data ownership and instant recovery if a tablet physically breaks.
- **Cross-Platform Delivery:** Runs natively as a Progressive Web App (PWA) across iOS, Android, Windows, Linux, and macOS.

---

## 2. Technical Stack

- **Framework:** SvelteKit (configured with `@sveltejs/adapter-static` for SPA fallback mode; SSR disabled).
- **Styling:** Tailwind CSS (high-contrast dark mode tailored for workshop lighting).
- **Database Engine:** `@sqlite.org/sqlite-wasm` running inside a **Dedicated Web Worker** (`worker.ts`) communicating via a strongly typed message protocol (`worker-protocol.ts`).
- **Language & Runtime:** TypeScript, Node.js (v24 pinned).
- **Testing:** Vitest (unit & database tests using in-memory SQLite), Playwright (cross-origin isolation and E2E persistence tests).

---

## 3. Database Standards & Schema Architecture

### Core Constraints
1. **Primary Keys:** All entity IDs use client-generated UUIDs (`id TEXT PRIMARY KEY` via `crypto.randomUUID()`). Auto-incrementing integers are strictly prohibited to allow conflict-free multi-device creation offline.
2. **Monetary Values:** All prices, labor costs, component rates, and totals are stored as **integer cents** (`INTEGER` e.g., `$45.00` is stored as `4500`) to prevent floating-point rounding drift.
3. **Foreign Keys & Cascades:** `PRAGMA foreign_keys = ON;` enabled on every connection, with `ON DELETE CASCADE` applied from `customers` $\rightarrow$ `bikes` $\rightarrow$ `work_orders` $\rightarrow$ `work_order_items`.
4. **Migrations:** Managed in an ordered `MIGRATIONS` array in `schema.ts`, tracked via `PRAGMA user_version`. Executed atomically inside a single `BEGIN IMMEDIATE` transaction.

### Schema Blueprint

```sql
-- Core Domain Entities
CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE bikes (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER,
    color TEXT,
    serial_number TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE work_orders (
    id TEXT PRIMARY KEY,
    bike_id TEXT NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled')) DEFAULT 'open',
    issue_summary TEXT NOT NULL,
    notes TEXT,
    total_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE work_order_items (
    id TEXT PRIMARY KEY,
    work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('labor', 'part')),
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Append-Only Transactional Outbox for Multi-Device Delta Sync
CREATE TABLE sync_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    entity_type TEXT NOT NULL, -- 'customer', 'bike', 'work_order', 'work_order_item'
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,      -- 'CREATE', 'UPDATE', 'DELETE'
    payload TEXT NOT NULL,     -- Serialized row payload JSON
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sync_outbox_seq ON sync_outbox(seq);
CREATE INDEX idx_sync_outbox_created_at ON sync_outbox(created_at);

-- Multi-Peer Sync Watermarks & Cursors
CREATE TABLE peer_sync_state (
    peer_id TEXT PRIMARY KEY,
    peer_name TEXT NOT NULL,
    last_synced_seq INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

---

## 4. Cross-Platform Compatibility & Deployment

### Operating System Matrix

| Platform | Recommended Browser | Storage Mechanism | PWA Installation |
| :--- | :--- | :--- | :--- |
| **macOS & Windows** | Chrome, Edge, Firefox, Safari | SQLite WASM in OPFS | Native PWA / Desktop App |
| **Linux** | Chrome, Firefox | SQLite WASM in OPFS | PWA window shortcut |
| **Android** | Chrome / Android Browser | SQLite WASM in OPFS | "Add to Home Screen" |
| **iOS / iPadOS** | Safari (Default & PWA mode) | SQLite WASM in OPFS | "Add to Home Screen" via Share sheet |

### Hosting Rules (COOP/COEP Headers)
To enable SQLite WASM synchronous file handles (`FileSystemSyncAccessHandle`) in OPFS without falling back to in-memory non-persistent storage, the host **must** send Cross-Origin Isolation headers:
```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
- **Supported Hosts:** Cloudflare Pages, Netlify, or Vercel (configured via native `_headers` or `vercel.json`).
- **GitHub Pages Note:** GitHub Pages does **not** support custom response headers. Deployments must target Cloudflare Pages or Netlify.

---

## 5. Multi-Device Handoffs & Synchronization Architecture

### 1. The Append-Only Outbox & Peer Watermark Pattern
All database mutations inside repository functions wrap the domain write and outbox entry in a single atomic `BEGIN IMMEDIATE` SQLite transaction. Instead of a destructive queue, `sync_outbox` acts as an append-only transaction ledger tracked via an auto-incrementing `seq` column. Multi-peer state is tracked via `peer_sync_state`, allowing peers to pull incremental deltas independently (`seq > last_synced_seq`) without premature record deletion.

### 2. Bring Your Own Storage (BYOS) Sync Layer
Mechanics do not configure complex server infrastructure or cloud databases. Instead, they authenticate via client-side OAuth (PKCE) in the settings UI to grant access to a single app folder in their personal cloud storage:
- **Supported Providers:** Dropbox, Google Drive, Microsoft OneDrive, or private S3/Cloudflare R2 buckets / WebDAV.
- **Background Sync Protocol:**
- **Push:** When changes exist in `sync_outbox`, the app writes encrypted JSON delta packets to the connected cloud folder via standard REST APIs (`fetch()`).
- **Pull:** When opening the app or regaining network access, the app lists pending outbox deltas from other devices, applies them to local SQLite using sequence tracking and watermark acknowledgments.

### 2.1 Transport Priority and Fallback (BYOS -> P2P)
`bike-mechanic-pad` supports multiple sync transports over the same append-only outbox and peer watermark model.

- **Primary transport:** BYOS cloud relay when configured.
- **Fallback transport:** direct **P2P WebRTC** sync when BYOS is not configured and a trusted peer is reachable.
- **No transport available:** continue local-first operation, keep writing mutations to `sync_outbox`, and sync later when any transport becomes available.

This keeps sync semantics consistent regardless of transport. Transport changes must never change domain write behavior or outbox event shape.

### 2.2 P2P Pairing and Trust Model
P2P sync uses explicit pairing and a user-approved trust relationship.

- **Pairing:** explicit offer/answer exchange (for example QR code or copy/paste token), not implicit LAN auto-discovery.
- **Trust:** peers are allow-listed before accepting deltas.
- **Channel security:** use WebRTC encrypted data channels and verify remote peer identity against the trusted peer list.

### 2.3 Conflict and Recovery Rules
Both BYOS and P2P must use the same conflict and recovery behavior.

- **Conflict policy:** shared deterministic policy across transports (for example last-write-wins by trusted timestamp/version metadata).
- **Bootstrap:** new or stale peers use snapshot bootstrap (`exportSnapshot` / `importSnapshot`) when outbox replay is insufficient.
- **Retention:** outbox pruning remains watermark-driven and retention-bounded, independent of transport choice.

### 2.4 Delivery Status
Current implementation focus is the database/repository layer (`sync_outbox`, peer cursors, pruning, snapshots).

- **Implemented now:** append-only outbox + peer cursor model in SQLite.
- **Planned next:** BYOS transport orchestrator and P2P WebRTC fallback transport orchestrator that consume the same repository APIs.

### 2.5 Near Real-Time Sync Profile (BYOS)
For solo-shop workflows, sync should feel near real-time (seconds-level freshness), not hard real-time.

- **Target freshness:** most cross-device updates visible within ~5-15 seconds while apps are foregrounded and connected.
- **Push behavior:**
- enqueue outbox entry immediately on each local mutation.
- trigger a push attempt after successful write commit.
- debounce/batch pushes over a short window (about 1-3 seconds) to reduce API chatter.
- **Pull behavior:**
- foreground polling every ~10 seconds.
- background/low-attention polling every ~30-60 seconds.
- immediate pull on app open/resume and network reconnect.
- **Reliability guardrails:**
- exponential backoff with jitter on provider/API failures.
- idempotent delta apply so retries are safe.
- if offline or provider unavailable, keep local writes and continue later from outbox.
- **User feedback:** show lightweight sync state (`Syncing`, `Up to date`, `Offline`, `Error`) and `last synced` timestamp for operator trust.

### 3. Garbage Control & Retention Pruning
Outbox logs are safely garbage-collected only when entries are older than the lowest active peer watermark (`seq <= MIN(last_synced_seq)`) and bounded by a maximum retention window (e.g., 30 days) to prevent unbounded table growth.

### 4. Snapshot Bootstrapping (New & Stale Peer Onboarding)
If a brand-new device joins the workshop, or a dormant device is turned on after exceeding the retention window, incremental log replay is impossible. In these scenarios, the device performs a **Full Database Snapshot** bootstrap (`exportSnapshot` / `importSnapshot`), downloads the complete ground-truth state, seeds its local tables atomically, and advances its sync cursor to the current cluster tip.

### 5. Master Takeover & Disaster Recovery
- **Database Export:** Settings UI includes an "Export Master Database (.sqlite3)" button, dumping the current OPFS SQLite binary file for local archival.
- **Master Takeover / Import:** Mechanics can upload a `.sqlite3` file to overwrite the local OPFS database instance, instantly promoting any replacement phone, tablet, or laptop to the master state.