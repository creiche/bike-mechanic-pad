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
  }
];
