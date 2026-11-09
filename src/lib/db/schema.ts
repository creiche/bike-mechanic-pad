// Ordered list of schema migrations. Entry N takes the database from version N-1 to version N.
// RULES: never edit or reorder an entry that has shipped; add a new entry at the end instead.
// The applied version is stored inside the database file (PRAGMA user_version), see migrate.ts.
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bikes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  color TEXT,
  serial_number TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bikes_customer_id ON bikes(customer_id);
`
  },
  {
    version: 2,
    name: 'reserved historical slot',
    sql: `
-- no-op
`
  },
  {
    version: 3,
    name: 'work orders + line items + sync outbox',
    sql: `
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  bike_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled')),
  issue_summary TEXT NOT NULL,
  notes TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_order_items (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('labor', 'part')),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_work_orders_bike_id ON work_orders(bike_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_work_order_items_work_order_id ON work_order_items(work_order_id);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at);
`
  },
  {
    version: 4,
    name: 'append-only sync outbox + peer cursors',
    sql: `
CREATE TABLE IF NOT EXISTS peer_sync_state (
  peer_id TEXT PRIMARY KEY,
  peer_name TEXT NOT NULL,
  last_synced_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_outbox_v4_new (
  -- Sole documented exception to "id TEXT PRIMARY KEY" (see CLAUDE.md): seq is this device's monotonic sync cursor.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO sync_outbox_v4_new (id, entity_type, entity_id, action, payload, created_at)
SELECT id, entity_type, entity_id, action, payload, created_at
FROM sync_outbox
ORDER BY created_at ASC, id ASC;

DROP TABLE IF EXISTS sync_outbox;
ALTER TABLE sync_outbox_v4_new RENAME TO sync_outbox;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_seq ON sync_outbox(seq);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_peer_sync_state_last_seen_at ON peer_sync_state(last_seen_at);
`
  },
  {
    version: 5,
    name: 'bike component ledger + line item component tag',
    sql: `
-- One row per (bike, component type); last_serviced_date is a local YYYY-MM-DD day.
CREATE TABLE IF NOT EXISTS bike_components (
  id TEXT PRIMARY KEY,
  bike_id TEXT NOT NULL,
  component_type TEXT NOT NULL,
  last_serviced_date TEXT NOT NULL,
  work_order_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (bike_id, component_type),
  FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bike_components_bike_id ON bike_components(bike_id);
CREATE INDEX IF NOT EXISTS idx_bike_components_work_order_id ON bike_components(work_order_id);

-- Tags a line item with the component it services; completing the work order stamps that component.
ALTER TABLE work_order_items ADD COLUMN component_type TEXT;
`
  },
  {
    version: 6,
    name: 'standard service menu',
    sql: `
-- Shop price list used to quick-add work order line items. archived_at hides an item without losing it.
CREATE TABLE IF NOT EXISTS service_menu_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  default_price_cents INTEGER NOT NULL CHECK (default_price_cents >= 0),
  item_type TEXT NOT NULL CHECK (item_type IN ('labor', 'part')),
  component_tag TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Fixed seed ids: every device seeds the same rows, so syncing never duplicates them.
-- The epoch updated_at makes any real edit win last-write-wins over a seed.
INSERT OR IGNORE INTO service_menu_items (id, category, name, default_price_cents, item_type, component_tag, created_at, updated_at) VALUES
  ('svc-seed-general-tune-up', 'package', 'General Tune-Up', 12000, 'labor', NULL, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-drivetrain-clean', 'labor', 'Drivetrain Clean', 4500, 'labor', NULL, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-chain-install', 'labor', 'Chain Install', 1500, 'labor', 'chain', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-cassette-install', 'labor', 'Cassette Install', 1500, 'labor', 'cassette', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-brake-pad-install', 'labor', 'Brake Pad Install', 2000, 'labor', 'brake_pads', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-brake-bleed', 'labor', 'Hydraulic Brake Bleed', 3500, 'labor', 'brake_bleed', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-bottom-bracket-install', 'labor', 'Bottom Bracket Install', 3000, 'labor', 'bottom_bracket', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-fork-service', 'package', 'Fork Service', 12000, 'labor', 'fork_service', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-rear-shock-service', 'package', 'Rear Shock Service', 10000, 'labor', 'rear_shock_service', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-tire-tube-replacement', 'labor', 'Tire / Tube Replacement', 1500, 'labor', NULL, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-tube-standard', 'part', 'Inner Tube', 900, 'part', NULL, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('svc-seed-chain-11-speed', 'part', 'Chain (11-speed)', 3500, 'part', NULL, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
`
  },
  {
    version: 7,
    name: 'customer + bike updated_at for last-write-wins sync',
    sql: `
-- SQLite cannot add a column with a non-constant default (datetime('now')), so use an epoch constant
-- and backfill existing rows from created_at. New rows always set updated_at explicitly in code.
ALTER TABLE customers ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE bikes ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
UPDATE customers SET updated_at = created_at;
UPDATE bikes SET updated_at = created_at;
`
  },
  {
    version: 8,
    name: 'restore outbox entity index',
    sql: `
-- Migration 4 rebuilt sync_outbox and lost this index; sync looks up a record's outbox rows for every incoming change.
CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_type, entity_id);
`
  }
];
