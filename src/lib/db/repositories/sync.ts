import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { openDatabase } from '../client';

type DomainAction = 'INSERT' | 'UPDATE' | 'DELETE';

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
	created_at: string;
}

export interface DatabaseSnapshot {
	version: number;
	exported_at: string;
	data: {
		customers: CustomerSnapshotRow[];
		bikes: BikeSnapshotRow[];
		work_orders: WorkOrderSnapshotRow[];
		work_order_items: WorkOrderItemSnapshotRow[];
	};
}

export interface AppendMutationInput {
	entity_type: string;
	entity_id: string;
	action: DomainAction;
	payload: Record<string, unknown>;
}

async function selectRows<T>(sql: string, bind: BindingSpec = []): Promise<T[]> {
	const connection = await openDatabase();
	const result = await connection.exec(sql, {
		bind,
		rowMode: 'object',
		returnValue: 'resultRows'
	});

	return Array.isArray(result) ? (result as T[]) : [];
}

async function selectOne<T>(sql: string, bind: BindingSpec = []): Promise<T | null> {
	const rows = await selectRows<T>(sql, bind);
	return rows[0] ?? null;
}

export async function appendMutation(input: AppendMutationInput): Promise<OutboxEntry> {
	const connection = await openDatabase();
	const eventId = crypto.randomUUID();

	await connection.exec(
		`INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload)
		 VALUES (?, ?, ?, ?, ?)`,
		{
			bind: [eventId, input.entity_type, input.entity_id, input.action, JSON.stringify(input.payload)]
		}
	);

	const row = await selectOne<OutboxEntry>('SELECT * FROM sync_outbox WHERE id = ?', [eventId]);
	if (!row) {
		throw new Error('Outbox row could not be loaded after insert.');
	}

	return row;
}

export async function getSyncDelta(
	peerId: string,
	limit = 500
): Promise<{ deltas: OutboxEntry[]; peer: PeerSyncState | null }> {
	const peer = await selectOne<PeerSyncState>('SELECT * FROM peer_sync_state WHERE peer_id = ?', [peerId]);
	const lastSyncedSeq = peer?.last_synced_seq ?? 0;
	const deltas = await selectRows<OutboxEntry>(
		`SELECT * FROM sync_outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
		[lastSyncedSeq, limit]
	);

	return { deltas, peer };
}

export async function acknowledgeSync(peerId: string, peerName: string, upToSeq: number): Promise<void> {
	const connection = await openDatabase();
	await connection.exec(
		`INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at)
		 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(peer_id) DO UPDATE SET
		   peer_name = excluded.peer_name,
		   last_synced_seq = MAX(peer_sync_state.last_synced_seq, excluded.last_synced_seq),
		   last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		{ bind: [peerId, peerName, upToSeq] }
	);
}

export async function pruneStaleOutboxLogs(retentionDays = 30, activeWithinDays = 30): Promise<number> {
	const connection = await openDatabase();
	const minActive = await selectOne<{ min_seq: number | null }>(
		`SELECT MIN(last_synced_seq) AS min_seq
		 FROM peer_sync_state
		 WHERE julianday(last_seen_at) >= julianday('now', '-' || ? || ' days')`,
		[activeWithinDays]
	);

	if (minActive?.min_seq == null) {
		await connection.exec(
			`DELETE FROM sync_outbox
			 WHERE julianday(created_at) < julianday('now', '-' || ? || ' days')`,
			{ bind: [retentionDays] }
		);
	} else {
		await connection.exec(
			`DELETE FROM sync_outbox
			 WHERE seq <= ?
			   AND julianday(created_at) < julianday('now', '-' || ? || ' days')`,
			{ bind: [minActive.min_seq, retentionDays] }
		);
	}

	const changes = await connection.exec('SELECT changes() AS deleted', {
		rowMode: 'object',
		returnValue: 'resultRows'
	});
	const deleted = Array.isArray(changes) && changes[0] ? (changes[0] as { deleted: number }).deleted : 0;
	return deleted;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
	const connection = await openDatabase();
	const versionRows = (await connection.exec('PRAGMA user_version', {
		rowMode: 'array',
		returnValue: 'resultRows'
	})) as number[][];
	const version = versionRows[0]?.[0] ?? 0;

	const customers = await selectRows<CustomerSnapshotRow>('SELECT * FROM customers ORDER BY created_at ASC, id ASC');
	const bikes = await selectRows<BikeSnapshotRow>('SELECT * FROM bikes ORDER BY created_at ASC, id ASC');
	const workOrders = await selectRows<WorkOrderSnapshotRow>(
		'SELECT * FROM work_orders ORDER BY created_at ASC, id ASC'
	);
	const workOrderItems = await selectRows<WorkOrderItemSnapshotRow>(
		'SELECT * FROM work_order_items ORDER BY created_at ASC, id ASC'
	);

	return {
		version,
		exported_at: new Date().toISOString(),
		data: {
			customers,
			bikes,
			work_orders: workOrders,
			work_order_items: workOrderItems
		}
	};
}

export async function importSnapshot(
	snapshot: DatabaseSnapshot,
	selfPeerId: string,
	selfPeerName = 'Self'
): Promise<void> {
	const connection = await openDatabase();
	await connection.exec('BEGIN IMMEDIATE');
	try {
		await connection.exec('DELETE FROM work_order_items');
		await connection.exec('DELETE FROM work_orders');
		await connection.exec('DELETE FROM bikes');
		await connection.exec('DELETE FROM customers');

		for (const customer of snapshot.data.customers) {
			await connection.exec(
				`INSERT INTO customers (id, name, phone, email, notes, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				{
					bind: [customer.id, customer.name, customer.phone, customer.email, customer.notes, customer.created_at]
				}
			);
		}

		for (const bike of snapshot.data.bikes) {
			await connection.exec(
				`INSERT INTO bikes (id, customer_id, brand, model, year, color, serial_number, notes, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
						bike.created_at
					]
				}
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
						workOrder.updated_at
					]
				}
			);
		}

		for (const item of snapshot.data.work_order_items) {
			await connection.exec(
				`INSERT INTO work_order_items (id, work_order_id, item_type, description, quantity, unit_price_cents, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				{
					bind: [
						item.id,
						item.work_order_id,
						item.item_type,
						item.description,
						item.quantity,
						item.unit_price_cents,
						item.created_at
					]
				}
			);
		}

		const tipRows = (await connection.exec('SELECT COALESCE(MAX(seq), 0) AS tip FROM sync_outbox', {
			rowMode: 'object',
			returnValue: 'resultRows'
		})) as Array<{ tip: number }>;
		const tip = tipRows[0]?.tip ?? 0;

		await connection.exec(
			`INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at)
			 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			 ON CONFLICT(peer_id) DO UPDATE SET
			   peer_name = excluded.peer_name,
			   last_synced_seq = excluded.last_synced_seq,
			   last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
			{ bind: [selfPeerId, selfPeerName, tip] }
		);

		await connection.exec('COMMIT');
	} catch (error) {
		try {
			await connection.exec('ROLLBACK');
		} catch {
			/* already rolled back */
		}
		throw error;
	}
}
