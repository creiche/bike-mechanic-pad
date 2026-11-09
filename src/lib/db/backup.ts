import { isComponentType, isServiceDate } from '../domain/componentTypes';
import { notifyLocalWrite } from './localWrites';
import { MIGRATIONS } from './schema';
import { exportSnapshot, importSnapshot, type DatabaseSnapshot } from './repositories/sync';
import { inTransaction } from './transaction';

// Thrown by validateSnapshot; `problems` lists every issue found (capped) so the UI can show them all.
export class SnapshotValidationError extends Error {
	constructor(readonly problems: string[]) {
		super(`This is not a valid backup file: ${problems.join(' ')}`);
		this.name = 'SnapshotValidationError';
	}
}

const MAX_PROBLEMS = 8;
const WORK_ORDER_STATUSES = ['open', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled'];
const ITEM_TYPES = ['labor', 'part'];
const MENU_CATEGORIES = ['labor', 'package', 'part'];
const SYNCED_ENTITY_TYPES = ['customer', 'bike', 'work_order', 'bike_component', 'service_menu_item'];

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonNegativeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// Check a parsed JSON value is a complete, self-consistent backup BEFORE anything is written.
// Covers shape, enums, integer cents, duplicate ids and parent references (the restore deletes everything first,
// so a half-valid file must be rejected up front rather than discovered mid-restore).
export function validateSnapshot(input: unknown): DatabaseSnapshot {
	const problems: string[] = [];
	const fail = (message: string) => {
		if (problems.length < MAX_PROBLEMS) problems.push(message);
	};

	if (!isRow(input) || !isRow(input.data)) {
		throw new SnapshotValidationError(['Missing "data" section.']);
	}
	if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) {
		fail('Missing schema version.');
	} else if ((input.version as number) > MIGRATIONS.length) {
		fail(`Backup is from a newer app version (schema ${input.version}); update the app first.`);
	}

	const data = input.data;
	// Table name -> rows. The first five are required; later additions may be absent in older backups.
	const required = ['customers', 'bikes', 'work_orders', 'work_order_items'];
	const optional = ['bike_components', 'service_menu_items', 'outbox'];
	const tables: Record<string, Row[]> = {};
	for (const name of [...required, ...optional]) {
		const value = data[name];
		if (value === undefined && optional.includes(name)) continue;
		if (!Array.isArray(value) || !value.every(isRow)) {
			fail(`"${name}" must be a list of records.`);
			continue;
		}
		tables[name] = value;
	}

	// Per-row checks and id collection.
	const ids: Record<string, Set<string>> = {};
	const check = (table: string, rule: (row: Row) => string | null) => {
		ids[table] = new Set();
		(tables[table] ?? []).forEach((row, index) => {
			const label = `${table}[${index}]`;
			if (typeof row.id !== 'string' || !row.id) return fail(`${label} has no id.`);
			if (ids[table].has(row.id)) return fail(`${label} repeats id ${row.id}.`);
			ids[table].add(row.id);
			const error = rule(row);
			if (error) fail(`${label} ${error}`);
		});
	};
	const str = (row: Row, keys: string[]) => keys.find((key) => typeof row[key] !== 'string' || !row[key]);
	const missing = (row: Row, keys: string[]) => {
		const key = str(row, keys);
		return key ? `is missing "${key}".` : null;
	};
	// A restore uploads these rows, and other devices reject a packet with a wrongly typed field on every retry.
	const notText = (row: Row, keys: string[]) => {
		const key = keys.find((name) => row[name] != null && typeof row[name] !== 'string');
		return key ? `has an invalid "${key}".` : null;
	};

	check('customers', (r) => missing(r, ['name', 'created_at']) ?? notText(r, ['phone', 'email', 'notes', 'updated_at']));
	check('bikes', (r) =>
		missing(r, ['customer_id', 'brand', 'model', 'created_at']) ??
		notText(r, ['color', 'serial_number', 'notes', 'updated_at']) ??
		(r.year != null && !Number.isSafeInteger(r.year) ? 'has an invalid year.' : null)
	);
	check('work_orders', (r) =>
		missing(r, ['bike_id', 'issue_summary', 'created_at', 'updated_at']) ??
		notText(r, ['notes']) ??
		(!WORK_ORDER_STATUSES.includes(r.status as string) ? 'has an invalid status.' : null) ??
		(!isNonNegativeInt(r.total_cents) ? 'total_cents must be whole cents.' : null)
	);
	check('work_order_items', (r) =>
		missing(r, ['work_order_id', 'description']) ??
		(!ITEM_TYPES.includes(r.item_type as string) ? 'has an invalid item_type.' : null) ??
		(!isNonNegativeInt(r.unit_price_cents) ? 'unit_price_cents must be whole cents.' : null) ??
		(!isNonNegativeInt(r.quantity) || r.quantity === 0 ? 'quantity must be a whole number of 1 or more.' : null) ??
		(r.component_type != null && !isComponentType(r.component_type) ? 'has an unknown component_type.' : null)
	);
	check('bike_components', (r) =>
		missing(r, ['bike_id', 'created_at', 'updated_at']) ??
		notText(r, ['work_order_id', 'notes']) ??
		(!isComponentType(r.component_type) ? 'has an unknown component_type.' : null) ??
		(typeof r.last_serviced_date !== 'string' || !isServiceDate(r.last_serviced_date)
			? 'last_serviced_date must be YYYY-MM-DD.'
			: null)
	);
	check('service_menu_items', (r) =>
		missing(r, ['name', 'created_at', 'updated_at']) ??
		notText(r, ['archived_at']) ??
		(!MENU_CATEGORIES.includes(r.category as string) ? 'has an invalid category.' : null) ??
		(!ITEM_TYPES.includes(r.item_type as string) ? 'has an invalid item_type.' : null) ??
		(!isNonNegativeInt(r.default_price_cents) ? 'default_price_cents must be whole cents.' : null) ??
		(r.component_tag != null && !isComponentType(r.component_tag) ? 'has an unknown component_tag.' : null)
	);

	// A restore re-queues the deletes listed here, so they must be something other devices can apply.
	for (const entry of tables.outbox ?? []) {
		if (entry.action === 'DELETE' && (!SYNCED_ENTITY_TYPES.includes(entry.entity_type as string) || typeof entry.entity_id !== 'string' || !entry.entity_id)) {
			fail(`outbox row ${String(entry.id)} is not a valid delete.`);
		}
	}

	// Parent references, so the restore can never trip a foreign key halfway through.
	const references: Array<[string, string, string]> = [
		['bikes', 'customer_id', 'customers'],
		['work_orders', 'bike_id', 'bikes'],
		['work_order_items', 'work_order_id', 'work_orders'],
		['bike_components', 'bike_id', 'bikes']
	];
	for (const [table, key, parent] of references) {
		for (const row of tables[table] ?? []) {
			if (typeof row[key] === 'string' && !ids[parent].has(row[key])) {
				fail(`${table} row ${String(row.id)} points to a missing ${parent} record.`);
			}
		}
	}

	// Each work order total must equal the sum of quantity * unit price of its items (integer cents).
	const itemTotals = new Map<string, number>();
	for (const item of tables.work_order_items ?? []) {
		if (typeof item.work_order_id !== 'string') continue;
		const line = Number(item.quantity) * Number(item.unit_price_cents);
		itemTotals.set(item.work_order_id, (itemTotals.get(item.work_order_id) ?? 0) + line);
	}
	for (const order of tables.work_orders ?? []) {
		const expected = itemTotals.get(order.id as string) ?? 0;
		if (isNonNegativeInt(order.total_cents) && order.total_cents !== expected) {
			fail(`work_orders row ${String(order.id)} total_cents (${order.total_cents}) does not match its items (${expected}).`);
		}
	}

	if (problems.length > 0) throw new SnapshotValidationError(problems);
	return input as unknown as DatabaseSnapshot;
}

export const backupFilename = (now: Date = new Date()): string => {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `bike-mechanic-pad-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
};

export async function createBackupJson(): Promise<string> {
	return JSON.stringify(await exportSnapshot(), null, 2);
}

// Parse + validate + restore (one SQLite transaction inside importSnapshot), then announce the write.
export async function restoreBackup(json: string, selfPeerId: string, selfPeerName: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new SnapshotValidationError(['The file is not valid JSON.']);
	}
	await importSnapshot(validateSnapshot(parsed), selfPeerId, selfPeerName);
	notifyLocalWrite();
}

// Wipe this device's shop data. The service menu is kept (it is the shop price list, not customer data), and so is the
// sync outbox, so nothing already queued is lost. Pull cursors restart from zero, including this device's own, so the
// next sync rebuilds everything from Dropbox instead of leaving a partial database.
export async function clearLocalDatabase(selfPeerId: string, selfPeerName: string): Promise<void> {
	await inTransaction(async (connection) => {
		// Children first; cascades would also work but this keeps the order obvious.
		for (const table of ['bike_components', 'work_order_items', 'work_orders', 'bikes', 'customers']) {
			await connection.exec(`DELETE FROM ${table}`);
		}
		await connection.exec(`DELETE FROM peer_sync_state WHERE peer_id LIKE 'pull:%'`);
		await connection.exec('INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq) VALUES (?, ?, 0)', {
			bind: [selfPeerId, selfPeerName]
		});
	});
	notifyLocalWrite();
}

// Changes not yet uploaded to a relay (Dropbox). Before any relay has synced, every outbox entry is pending.
export async function countPendingOutbox(): Promise<number> {
	const rows = (await inTransaction((connection) =>
		connection.exec(
			`SELECT COUNT(*) AS pending FROM sync_outbox
			 WHERE seq > COALESCE((SELECT MAX(last_synced_seq) FROM peer_sync_state WHERE peer_id LIKE 'relay:%'), 0)`,
			{ rowMode: 'object', returnValue: 'resultRows' }
		)
	)) as Array<{ pending: number }>;
	return rows[0]?.pending ?? 0;
}
