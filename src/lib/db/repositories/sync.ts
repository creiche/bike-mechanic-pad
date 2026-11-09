import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { openDatabase, selectRows, type SqliteConnection } from "../client";
import { inTransaction } from "../transaction";

type DomainAction = "INSERT" | "UPDATE" | "DELETE";

// peer_sync_state holds two kinds of cursors. A push cursor counts OUR outbox seq already uploaded.
// A pull cursor counts a REMOTE device's seq already applied here; it lives in another seq space,
// so pruning must ignore it.
const PULL_PEER_PREFIX = "pull:";

export const pushPeerId = (relayId: string): string => `relay:${relayId}`;
export const pullPeerId = (deviceId: string): string =>
  `${PULL_PEER_PREFIX}${deviceId}`;

// Thrown when a remote delta is malformed or from a newer app version; retrying will not help.
export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProtocolError";
  }
}

export interface OutboxEntry {
  seq: number;
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: string;
  created_at: string;
}

export interface PeerSyncState {
  peer_id: string;
  peer_name: string;
  last_synced_seq: number;
  last_seen_at: string;
}

interface CustomerSnapshotRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
    notes: string | null;
  created_at: string;
  // Absent in backups made before schema v7; import falls back to created_at.
  updated_at?: string;
}

interface BikeSnapshotRow {
  id: string;
  customer_id: string;
  brand: string;
  model: string;
  year: number | null;
  color: string | null;
  serial_number: string | null;
    notes: string | null;
  created_at: string;
  updated_at?: string;
}

interface WorkOrderSnapshotRow {
  id: string;
  bike_id: string;
  status: string;
  issue_summary: string;
  notes: string | null;
  total_cents: number;
  created_at: string;
  updated_at: string;
}

interface WorkOrderItemSnapshotRow {
  id: string;
  work_order_id: string;
  item_type: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  component_type?: string | null;
  created_at: string;
}

interface BikeComponentSnapshotRow {
  id: string;
  bike_id: string;
  component_type: string;
  last_serviced_date: string;
  work_order_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ServiceMenuItemSnapshotRow {
  id: string;
  category: string;
  name: string;
  default_price_cents: number;
  item_type: string;
  component_tag: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseSnapshot {
  version: number;
  exported_at: string;
  data: {
    customers: CustomerSnapshotRow[];
    bikes: BikeSnapshotRow[];
    work_orders: WorkOrderSnapshotRow[];
    work_order_items: WorkOrderItemSnapshotRow[];
    // Absent in snapshots exported before schema v5.
    bike_components?: BikeComponentSnapshotRow[];
    // Absent in snapshots exported before schema v6; an absent list leaves the local menu untouched.
    service_menu_items?: ServiceMenuItemSnapshotRow[];
    // Informational copy of the sync outbox at export time; restore does not replay it.
    outbox?: OutboxEntry[];
  };
}

export interface AppendMutationInput {
  entity_type: string;
  entity_id: string;
  action: DomainAction;
  payload: Record<string, unknown>;
}

async function selectOne<T>(
  sql: string,
  bind: BindingSpec = [],
): Promise<T | null> {
  const rows = await selectRows<T>(sql, bind);
  return rows[0] ?? null;
}

export async function appendMutation(
  input: AppendMutationInput,
): Promise<OutboxEntry> {
  const connection = await openDatabase();
  const eventId = crypto.randomUUID();

  await connection.exec(
    `INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload)
		 VALUES (?, ?, ?, ?, ?)`,
    {
      bind: [
        eventId,
        input.entity_type,
        input.entity_id,
        input.action,
        JSON.stringify(input.payload),
      ],
    },
  );

  const row = await selectOne<OutboxEntry>(
    "SELECT * FROM sync_outbox WHERE id = ?",
    [eventId],
  );
  if (!row) {
    throw new Error("Outbox row could not be loaded after insert.");
  }

  return row;
}

export async function getSyncDelta(
  peerId: string,
  limit = 500,
): Promise<{ deltas: OutboxEntry[]; peer: PeerSyncState | null }> {
  // Inside the transaction queue so we never read another caller's uncommitted outbox rows.
  return inTransaction(async () => {
    const peer = await selectOne<PeerSyncState>(
      "SELECT * FROM peer_sync_state WHERE peer_id = ?",
      [peerId],
    );
    const lastSyncedSeq = peer?.last_synced_seq ?? 0;
    const deltas = await selectRows<OutboxEntry>(
      `SELECT * FROM sync_outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      [lastSyncedSeq, limit],
    );

    return { deltas, peer };
  });
}

export function acknowledgeSync(
  peerId: string,
  peerName: string,
  upToSeq: number,
): Promise<void> {
  return inTransaction((connection) =>
    writeAck(connection, peerId, peerName, upToSeq),
  );
}

// Shared by acknowledgeSync and applyRemoteDeltas, which already holds the transaction (no nesting allowed).
async function writeAck(
  connection: SqliteConnection,
  peerId: string,
  peerName: string,
  upToSeq: number,
): Promise<void> {
  await connection.exec(
    `INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at)
		 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(peer_id) DO UPDATE SET
		   peer_name = excluded.peer_name,
		   last_synced_seq = MAX(peer_sync_state.last_synced_seq, excluded.last_synced_seq),
		   last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    { bind: [peerId, peerName, upToSeq] },
  );
}

export function pruneStaleOutboxLogs(
  retentionDays = 30,
  activeWithinDays = 30,
): Promise<number> {
  return inTransaction((connection) =>
    pruneWithin(connection, retentionDays, activeWithinDays),
  );
}

async function pruneWithin(
  connection: SqliteConnection,
  retentionDays: number,
  activeWithinDays: number,
): Promise<number> {
  const minActive = await selectOne<{ min_seq: number | null }>(
    `SELECT MIN(last_synced_seq) AS min_seq
		 FROM peer_sync_state
		 WHERE julianday(last_seen_at) >= julianday('now', '-' || ? || ' days')
		   AND peer_id NOT LIKE ?`,
    [activeWithinDays, `${PULL_PEER_PREFIX}%`],
  );

  if (minActive?.min_seq == null) {
    await connection.exec(
      `DELETE FROM sync_outbox
			 WHERE julianday(created_at) < julianday('now', '-' || ? || ' days')`,
      { bind: [retentionDays] },
    );
  } else {
    await connection.exec(
      `DELETE FROM sync_outbox
			 WHERE seq <= ?
			   AND julianday(created_at) < julianday('now', '-' || ? || ' days')`,
      { bind: [minActive.min_seq, retentionDays] },
    );
  }

  const changes = await connection.exec("SELECT changes() AS deleted", {
    rowMode: "object",
    returnValue: "resultRows",
  });
  const deleted =
    Array.isArray(changes) && changes[0]
      ? (changes[0] as { deleted: number }).deleted
      : 0;
  return deleted;
}

// One read transaction so a concurrent sync write cannot leave the 7 queries mutually inconsistent.
export function exportSnapshot(): Promise<DatabaseSnapshot> {
  return inTransaction(async (connection) => {
    const versionRows = (await connection.exec("PRAGMA user_version", {
      rowMode: "array",
      returnValue: "resultRows",
    })) as number[][];
    const version = versionRows[0]?.[0] ?? 0;

    const customers = await selectRows<CustomerSnapshotRow>(
      "SELECT * FROM customers ORDER BY created_at ASC, id ASC",
    );
    const bikes = await selectRows<BikeSnapshotRow>(
      "SELECT * FROM bikes ORDER BY created_at ASC, id ASC",
    );
    const workOrders = await selectRows<WorkOrderSnapshotRow>(
      "SELECT * FROM work_orders ORDER BY created_at ASC, id ASC",
    );
    const workOrderItems = await selectRows<WorkOrderItemSnapshotRow>(
      "SELECT * FROM work_order_items ORDER BY created_at ASC, id ASC",
    );
    const bikeComponents = await selectRows<BikeComponentSnapshotRow>(
      "SELECT * FROM bike_components ORDER BY created_at ASC, id ASC",
    );

    const serviceMenuItems = await selectRows<ServiceMenuItemSnapshotRow>(
      "SELECT * FROM service_menu_items ORDER BY created_at ASC, id ASC",
    );

    const outbox = await selectRows<OutboxEntry>(
      "SELECT * FROM sync_outbox ORDER BY seq ASC",
    );

    return {
      version,
      exported_at: new Date().toISOString(),
      data: {
        customers,
        bikes,
        work_orders: workOrders,
        work_order_items: workOrderItems,
        bike_components: bikeComponents,
        service_menu_items: serviceMenuItems,
        outbox,
      },
    };
  });
}

export async function importSnapshot(
  snapshot: DatabaseSnapshot,
  selfPeerId: string,
  selfPeerName = "Self",
): Promise<void> {
  await inTransaction(async (connection) => {
    await connection.exec("DELETE FROM bike_components");
    await connection.exec("DELETE FROM work_order_items");
    await connection.exec("DELETE FROM work_orders");
    await connection.exec("DELETE FROM bikes");
    await connection.exec("DELETE FROM customers");

    for (const customer of snapshot.data.customers) {
      await connection.exec(
        `INSERT INTO customers (id, name, phone, email, notes, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        {
          bind: [
            customer.id,
            customer.name,
            customer.phone,
            customer.email,
            customer.notes,
                        customer.created_at,
            customer.updated_at ?? customer.created_at,
          ],
        },
      );
    }

    for (const bike of snapshot.data.bikes) {
      await connection.exec(
        `INSERT INTO bikes (id, customer_id, brand, model, year, color, serial_number, notes, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          bind: [
            bike.id,
            bike.customer_id,
            bike.brand,
            bike.model,
            bike.year,
            bike.color,
            bike.serial_number,
            bike.notes,
                        bike.created_at,
            bike.updated_at ?? bike.created_at,
          ],
        },
      );
    }

    for (const workOrder of snapshot.data.work_orders) {
      await connection.exec(
        `INSERT INTO work_orders (id, bike_id, status, issue_summary, notes, total_cents, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          bind: [
            workOrder.id,
            workOrder.bike_id,
            workOrder.status,
            workOrder.issue_summary,
            workOrder.notes,
            workOrder.total_cents,
            workOrder.created_at,
            workOrder.updated_at,
          ],
        },
      );
    }

    for (const item of snapshot.data.work_order_items) {
      await connection.exec(
        `INSERT INTO work_order_items (id, work_order_id, item_type, description, quantity, unit_price_cents, component_type, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          bind: [
            item.id,
            item.work_order_id,
            item.item_type,
            item.description,
            item.quantity,
            item.unit_price_cents,
            item.component_type ?? null,
            item.created_at,
          ],
        },
      );
    }

    for (const component of snapshot.data.bike_components ?? []) {
      await connection.exec(
        `INSERT INTO bike_components
				   (id, bike_id, component_type, last_serviced_date, work_order_id, notes, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          bind: [
            component.id,
            component.bike_id,
            component.component_type,
            component.last_serviced_date,
            component.work_order_id,
            component.notes,
            component.created_at,
            component.updated_at,
          ],
        },
      );
    }

    if (snapshot.data.service_menu_items) {
      await connection.exec("DELETE FROM service_menu_items");
      for (const item of snapshot.data.service_menu_items) {
        await connection.exec(
          `INSERT INTO service_menu_items
					   (id, category, name, default_price_cents, item_type, component_tag, archived_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          {
            bind: [
              item.id,
              item.category,
              item.name,
              item.default_price_cents,
              item.item_type,
              item.component_tag,
              item.archived_at,
              item.created_at,
              item.updated_at,
            ],
          },
        );
      }
    }

    const tipRows = (await connection.exec(
      "SELECT COALESCE(MAX(seq), 0) AS tip FROM sync_outbox",
      {
        rowMode: "object",
        returnValue: "resultRows",
      },
    )) as Array<{ tip: number }>;
    const tip = tipRows[0]?.tip ?? 0;

    await connection.exec(
      `INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at)
			 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			 ON CONFLICT(peer_id) DO UPDATE SET
			   peer_name = excluded.peer_name,
			   last_synced_seq = excluded.last_synced_seq,
			   last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      { bind: [selfPeerId, selfPeerName, tip] },
    );
  });
}

export async function getPeerState(
  peerId: string,
): Promise<PeerSyncState | null> {
  return selectOne<PeerSyncState>(
    "SELECT * FROM peer_sync_state WHERE peer_id = ?",
    [peerId],
  );
}

export interface ApplyRemoteResult {
  applied: number;
  // Set when a delta pointed at a parent row that has not arrived yet. Processing stopped there and the
  // cursor stays just before that delta, so the next sync cycle retries it (and everything after it).
  blocked: boolean;
  lastSyncedSeq: number;
}

type Payload = Record<string, unknown>;

function parsePayload(delta: OutboxEntry): Payload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(delta.payload);
  } catch {
    throw new SyncProtocolError(`Delta ${delta.id} has an unreadable payload.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyncProtocolError(`Delta ${delta.id} payload must be an object.`);
  }
  return parsed as Payload;
}

function requireString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new SyncProtocolError(`Payload field "${key}" must be a string.`);
  }
  return value;
}

function optionalString(payload: Payload, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new SyncProtocolError(`Payload field "${key}" must be a string.`);
  }
  return value;
}

function optionalInteger(payload: Payload, key: string): number | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw new SyncProtocolError(`Payload field "${key}" must be an integer.`);
  }
  return value as number;
}

function requireInteger(payload: Payload, key: string): number {
  const value = optionalInteger(payload, key);
  if (value === null) {
    throw new SyncProtocolError(`Payload field "${key}" must be an integer.`);
  }
  return value;
}

// KNOWN LIMITS of this sync design (accepted for a small shop with 1-3 devices):
// - Deletes leave no tombstone. If device A deletes a record while device B (offline) edits it, B's later
//   UPDATE re-creates the row on A (when its parent still exists) while B applies A's DELETE, so the two
//   devices disagree until someone deletes it again. A fix would add a deleted_at tombstone per entity.
// - Last-write-wins compares updated_at values written by each device's own clock. A device whose clock is
//   badly wrong wins conflicts it should lose. Keep tablet clocks on automatic time.
// Customers, bikes, work orders, bike components and menu items all use last-write-wins on updated_at.
async function applyCustomer(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (delta.action === "DELETE") {
    await connection.exec("DELETE FROM customers WHERE id = ?", {
      bind: [delta.entity_id],
    });
    return;
  }

    const payload = parsePayload(delta);
  const id = requireString(payload, "id");
  const updatedAt = optionalString(payload, "updated_at") ?? delta.created_at;

  const existing = await selectOne<{ updated_at: string }>(
    "SELECT updated_at FROM customers WHERE id = ?",
    [id],
  );
  if (existing && existing.updated_at > updatedAt) return;

  await connection.exec(
    `INSERT INTO customers (id, name, phone, email, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name, phone = excluded.phone, email = excluded.email, notes = excluded.notes,
			   updated_at = excluded.updated_at`,
    {
      bind: [
        id,
        requireString(payload, "name"),
        optionalString(payload, "phone"),
        optionalString(payload, "email"),
        optionalString(payload, "notes"),
                optionalString(payload, "created_at") ?? delta.created_at,
        updatedAt,
      ],
    },
  );
}

async function applyBike(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (delta.action === "DELETE") {
    await connection.exec("DELETE FROM bikes WHERE id = ?", {
      bind: [delta.entity_id],
    });
    return;
  }

    const payload = parsePayload(delta);
  const id = requireString(payload, "id");
  const updatedAt = optionalString(payload, "updated_at") ?? delta.created_at;

  const existing = await selectOne<{ updated_at: string }>(
    "SELECT updated_at FROM bikes WHERE id = ?",
    [id],
  );
  if (existing && existing.updated_at > updatedAt) return;

  await connection.exec(
    `INSERT INTO bikes (id, customer_id, brand, model, year, color, serial_number, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   customer_id = excluded.customer_id, brand = excluded.brand, model = excluded.model,
			   year = excluded.year, color = excluded.color, serial_number = excluded.serial_number,
			   notes = excluded.notes, updated_at = excluded.updated_at`,
    {
      bind: [
        id,
        requireString(payload, "customer_id"),
        requireString(payload, "brand"),
        requireString(payload, "model"),
        optionalInteger(payload, "year"),
        optionalString(payload, "color"),
        optionalString(payload, "serial_number"),
                optionalString(payload, "notes"),
        optionalString(payload, "created_at") ?? delta.created_at,
        updatedAt,
      ],
    },
  );
}

// Work orders resolve conflicts by last-write-wins on updated_at (event time when the payload has none).
async function applyWorkOrder(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (delta.action === "DELETE") {
    await connection.exec("DELETE FROM work_orders WHERE id = ?", {
      bind: [delta.entity_id],
    });
    return;
  }

  const payload = parsePayload(delta);
  const id = requireString(payload, "id");
  const updatedAt = optionalString(payload, "updated_at") ?? delta.created_at;

  const existing = await selectOne<{ updated_at: string }>(
    "SELECT updated_at FROM work_orders WHERE id = ?",
    [id],
  );
  if (existing && existing.updated_at > updatedAt) return;

  const items = payload.items ?? [];
  if (!Array.isArray(items)) {
    throw new SyncProtocolError('Payload field "items" must be an array.');
  }

  await connection.exec(
    `INSERT INTO work_orders (id, bike_id, status, issue_summary, notes, total_cents, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   bike_id = excluded.bike_id, status = excluded.status, issue_summary = excluded.issue_summary,
		   notes = excluded.notes, total_cents = excluded.total_cents, updated_at = excluded.updated_at`,
    {
      bind: [
        id,
        requireString(payload, "bike_id"),
        requireString(payload, "status"),
        requireString(payload, "issue_summary"),
        optionalString(payload, "notes"),
        requireInteger(payload, "total_cents"),
        optionalString(payload, "created_at") ?? delta.created_at,
        updatedAt,
      ],
    },
  );

  await connection.exec(
    "DELETE FROM work_order_items WHERE work_order_id = ?",
    { bind: [id] },
  );
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SyncProtocolError("Work order items must be objects.");
    }
    const item = raw as Payload;
    await connection.exec(
      `INSERT INTO work_order_items (id, work_order_id, item_type, description, quantity, unit_price_cents, component_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
      {
        bind: [
          requireString(item, "id"),
          id,
          requireString(item, "item_type"),
          requireString(item, "description"),
          requireInteger(item, "quantity"),
          requireInteger(item, "unit_price_cents"),
          optionalString(item, "component_type"),
        ],
      },
    );
  }
}

// One ledger row per (bike, component type): when two devices created the same pair with different ids,
// the later updated_at wins and the other row is dropped.
async function applyBikeComponent(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (delta.action === "DELETE") {
    await connection.exec("DELETE FROM bike_components WHERE id = ?", {
      bind: [delta.entity_id],
    });
    return;
  }

  const payload = parsePayload(delta);
  const id = requireString(payload, "id");
  const bikeId = requireString(payload, "bike_id");
  const componentType = requireString(payload, "component_type");
  const updatedAt = optionalString(payload, "updated_at") ?? delta.created_at;

  const rival = await selectOne<{ id: string; updated_at: string }>(
    "SELECT id, updated_at FROM bike_components WHERE bike_id = ? AND component_type = ? AND id != ?",
    [bikeId, componentType, id],
  );
  if (rival) {
    if (rival.updated_at > updatedAt) return;
    await connection.exec("DELETE FROM bike_components WHERE id = ?", {
      bind: [rival.id],
    });
  }

  const existing = await selectOne<{ updated_at: string }>(
    "SELECT updated_at FROM bike_components WHERE id = ?",
    [id],
  );
  if (existing && existing.updated_at > updatedAt) return;

  await connection.exec(
    `INSERT INTO bike_components
		   (id, bike_id, component_type, last_serviced_date, work_order_id, notes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   bike_id = excluded.bike_id, component_type = excluded.component_type,
		   last_serviced_date = excluded.last_serviced_date, work_order_id = excluded.work_order_id,
		   notes = excluded.notes, updated_at = excluded.updated_at`,
    {
      bind: [
        id,
        bikeId,
        componentType,
        requireString(payload, "last_serviced_date"),
        optionalString(payload, "work_order_id"),
        optionalString(payload, "notes"),
        optionalString(payload, "created_at") ?? delta.created_at,
        updatedAt,
      ],
    },
  );
}

// Last-write-wins on updated_at, so the newest edit (or archive) survives on every device.
async function applyServiceMenuItem(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (delta.action === "DELETE") {
    await connection.exec("DELETE FROM service_menu_items WHERE id = ?", {
      bind: [delta.entity_id],
    });
    return;
  }

  const payload = parsePayload(delta);
  const id = requireString(payload, "id");
  const updatedAt = optionalString(payload, "updated_at") ?? delta.created_at;

  const existing = await selectOne<{ updated_at: string }>(
    "SELECT updated_at FROM service_menu_items WHERE id = ?",
    [id],
  );
  if (existing && existing.updated_at > updatedAt) return;

  await connection.exec(
    `INSERT INTO service_menu_items
		   (id, category, name, default_price_cents, item_type, component_tag, archived_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   category = excluded.category, name = excluded.name, default_price_cents = excluded.default_price_cents,
		   item_type = excluded.item_type, component_tag = excluded.component_tag,
		   archived_at = excluded.archived_at, updated_at = excluded.updated_at`,
    {
      bind: [
        id,
        requireString(payload, "category"),
        requireString(payload, "name"),
        requireInteger(payload, "default_price_cents"),
        requireString(payload, "item_type"),
        optionalString(payload, "component_tag"),
        optionalString(payload, "archived_at"),
        optionalString(payload, "created_at") ?? delta.created_at,
        updatedAt,
      ],
    },
  );
}

function applyDelta(
  connection: SqliteConnection,
  delta: OutboxEntry,
): Promise<void> {
  if (
    delta.action !== "INSERT" &&
    delta.action !== "UPDATE" &&
    delta.action !== "DELETE"
  ) {
    throw new SyncProtocolError(`Unknown action "${delta.action}".`);
  }

  switch (delta.entity_type) {
    case "customer":
      return applyCustomer(connection, delta);
    case "bike":
      return applyBike(connection, delta);
    case "work_order":
      return applyWorkOrder(connection, delta);
    case "bike_component":
      return applyBikeComponent(connection, delta);
    case "service_menu_item":
      return applyServiceMenuItem(connection, delta);
    default:
      throw new SyncProtocolError(
        `Unknown entity type "${delta.entity_type}"; update the app to sync it.`,
      );
  }
}

function isForeignKeyError(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY/i.test(error.message);
}

// Apply a remote device's deltas and advance its pull cursor in ONE transaction, so a crash can never
// leave rows applied without the cursor (or the reverse). Deltas at or below the cursor are ignored,
// which makes retries and overlapping packets safe. Applied rows are NOT written to sync_outbox,
// otherwise every change would echo back to the device that sent it.
// A missing parent (foreign key error) stops the batch: the cursor stays before the failed delta so the
// next cycle retries it once the parent has arrived. DELETE deltas never hit this path.
export async function applyRemoteDeltas(
  peerId: string,
  peerName: string,
  deltas: OutboxEntry[],
): Promise<ApplyRemoteResult> {
  return inTransaction(async (connection) => {
    const peer = await getPeerState(peerId);
    let cursor = peer?.last_synced_seq ?? 0;
    let applied = 0;
    let blocked = false;

    for (const delta of [...deltas].sort((a, b) => a.seq - b.seq)) {
      if (delta.seq <= cursor) continue;

      await connection.exec("SAVEPOINT remote_delta");
      try {
        await applyDelta(connection, delta);
        await connection.exec("RELEASE remote_delta");
        applied++;
        cursor = delta.seq;
      } catch (error) {
        await connection.exec("ROLLBACK TO remote_delta");
        await connection.exec("RELEASE remote_delta");
        if (!isForeignKeyError(error)) throw error;
        blocked = true;
        break;
      }
    }

    await writeAck(connection, peerId, peerName, cursor);
    return { applied, blocked, lastSyncedSeq: cursor };
  });
}

// The repository surface the sync service depends on; lets tests swap in a fake.
export interface SyncRepository {
  getSyncDelta: typeof getSyncDelta;
  acknowledgeSync: typeof acknowledgeSync;
  getPeerState: typeof getPeerState;
  applyRemoteDeltas: typeof applyRemoteDeltas;
  pruneStaleOutboxLogs: typeof pruneStaleOutboxLogs;
}

export const syncRepository: SyncRepository = {
  getSyncDelta,
  acknowledgeSync,
  getPeerState,
  applyRemoteDeltas,
  pruneStaleOutboxLogs,
};
