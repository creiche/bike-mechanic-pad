# Bike Mechanic Pad (`bike-mechanic-pad`)
> A free, local-first, offline-first digital clipboard for solo bike mechanics.
> **License:** GPLv3

---

## 1. Executive Summary & Vision

`bike-mechanic-pad` is a privacy-respecting, zero-telemetry web application designed for solo bike mechanics working on shop floors, at mobile repair rigs, or in home workshops. 

### Core Product Principles:
- **Local-First & Offline-First:** All customer, bike, and work order data lives on the user's device inside an SQLite database in OPFS (Origin Private File System). It requires zero internet connection to function.
- **Serverless Multi-Device Sync:** Mechanics can seamlessly switch between an iPhone on the shop floor, an iPad on the repair stand, and a desktop in the office throughout the day, over a direct local WebRTC link or a self-hosted WebDAV server used as a dumb drop-off relay.
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
    component_type TEXT, -- optional ledger tag: chain, cassette, brake_pads, fork_service, rear_shock_service, bottom_bracket
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-bike component service ledger (stamped automatically when a work order completes)
CREATE TABLE bike_components (
    id TEXT PRIMARY KEY,
    bike_id TEXT NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
    component_type TEXT NOT NULL,
    last_serviced_date TEXT NOT NULL, -- local calendar day, YYYY-MM-DD
    work_order_id TEXT REFERENCES work_orders(id) ON DELETE SET NULL, -- NULL = manual entry
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (bike_id, component_type)
);

-- Append-Only Transactional Outbox for Multi-Device Delta Sync
CREATE TABLE sync_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    entity_type TEXT NOT NULL, -- 'customer', 'bike', 'work_order', 'work_order_item', 'bike_component'
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

### 2. Decentralized Dual-Transport Model
To maintain strict data sovereignty, zero server costs, and zero reliance on proprietary corporate API keys (like Dropbox or Google Drive), `bike-mechanic-pad` uses a two-tier decentralized sync architecture:

- **Primary Default Transport (Local P2P WebRTC):** For day-to-day shop floor use when devices (e.g., a tablet on the stand and a mechanic's phone) are on the same local network. It establishes a direct, encrypted P2P DataChannel with zero cloud infrastructure.
- **Advanced / Remote Transport (Open-Standard WebDAV):** For mechanics who need to sync out-of-shop or wish to connect to a self-hosted cloud (Nextcloud, personal NAS, etc.) via standard RFC 4918 protocols.

### 2.1 P2P Pairing & Trust Model (WebRTC Default)
Because WebRTC requires an initial connection handshake without a central server, pairing follows an explicit zero-config workflow:
- **Two-Scan QR Handshake:** The first device shows an offer as a QR code; the second scans it and shows a reply; the first scans that. Each code holds only the ICE credentials, DTLS fingerprint, and host candidates, and the other side rebuilds the SDP from them. Because the fingerprint travels by camera, a scan authenticates the device on the other end.
- **Persistent Trust:** Each device keeps one `RTCCertificate` in IndexedDB so its DTLS fingerprint is stable. A QR pairing saves the other device's fingerprint in `peer_sync_state.dtls_fingerprint`, on that device's push-cursor row, and only a QR pairing can create or change it. Trust is device-local: it is never exported or synced. Certificates are capped at one year by browsers, after which devices pair by QR again.
- **Mesh Recovery:** With no signalling server, a device that lost all its links needs one QR pairing with any linked device. Linked devices tell each other who else they are linked to, and pass handshakes between remembered devices over those links; the lower device id offers. The device in the middle is only a courier: each end rejects a handshake whose fingerprint differs from the one it saved. Links, not trust, are lost on reload.
- **Pull-Only Exchange:** Each device serves its outbox as a virtual folder of packets, and the other pulls them in its normal sync cycle. A pull request carries the requester's cursor, which is its durable ACK. Neither side waits on the other's sync lock, so simultaneous syncs cannot deadlock.
- **No Forwarding:** Applied rows are not re-added to the outbox, so a device only serves changes it authored. A child record whose parent may still be on a third device stalls rather than being dropped.

### 2.2 WebDAV Client Transport (Remote / Advanced)
For out-of-shop use, users can configure a WebDAV URL, username, and password in settings. The app pushes and pulls serialized JSON outbox deltas directly to their private server without any third-party app gating or developer keys.

### 2.3 Conflict and Recovery Rules
- **Conflict Policy:** Shared deterministic last-write-wins per entity record based on timestamp metadata.
- **Bootstrap:** New or stale peers use full snapshot export/import (`exportSnapshot` / `importSnapshot`) when outbox log replay exceeds the retention window.
- **Retention:** Outbox pruning remains watermark-driven (`seq <= MIN(last_synced_seq)`) and bounded by a maximum time window (e.g., 30 days).

### 3. Master Takeover & Disaster Recovery
- **Database Export:** Settings UI includes an "Export Master Database (.sqlite3)" button, dumping the current OPFS SQLite binary file for local archival.
- **Master Takeover / Import:** Mechanics can upload a `.sqlite3` file to overwrite the local OPFS database instance, instantly promoting any replacement phone, tablet, or laptop to the master state.