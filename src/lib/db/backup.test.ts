import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from './migrate';

type TestDb = { exec(sql: string, options?: Record<string, unknown>): unknown };
let db: TestDb;

vi.mock('./client', () => {
	const exec = (sql: string, options: { bind?: BindingSpec; rowMode?: string; returnValue?: string } = {}) =>
		Promise.resolve(db.exec(sql, options));
	return {
		openDatabase: async () => ({ exec }),
		selectRows: async (sql: string, bind: BindingSpec = []) =>
			db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }),
		runQuery: (sql: string, bind: BindingSpec = []) => exec(sql, { bind })
	};
});

import {
	backupFilename,
	clearLocalDatabase,
	countPendingOutbox,
	createBackupJson,
	restoreBackup,
	SnapshotValidationError,
	validateSnapshot
} from './backup';
import { onLocalWrite } from './localWrites';
import { createBike, createCustomer } from './repositories';
import { createWorkOrder } from './repositories/workOrders';

const sqlite3 = await sqlite3InitModule();
const queryRows = (sql: string) => db.exec(sql, { rowMode: 'object', returnValue: 'resultRows' }) as Array<Record<string, unknown>>;

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

async function seedShop() {
	const customer = await createCustomer({ name: 'Ana' });
	const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
	await createWorkOrder({
		bike_id: bike.id,
		status: 'completed',
		issue_summary: 'Chain',
		items: [{ item_type: 'part', description: 'Chain', quantity: 2, unit_price_cents: 3555, component_type: 'chain' }]
	});
}

const parsed = async () => JSON.parse(await createBackupJson());

describe('backup export', () => {
	it('names the file by local date', () => {
		expect(backupFilename(new Date(2026, 10, 8))).toBe('bike-mechanic-pad-backup-2026-11-08.json');
	});

	it('serializes every table including the outbox', async () => {
		await seedShop();
		const snapshot = await parsed();
		expect(Object.keys(snapshot.data).sort()).toEqual(
			['bike_components', 'bikes', 'customers', 'outbox', 'service_menu_items', 'work_order_items', 'work_orders']
		);
		expect(snapshot.data.work_order_items[0].unit_price_cents).toBe(3555);
		expect(snapshot.data.outbox.length).toBeGreaterThan(0);
		expect(snapshot.data.service_menu_items.length).toBeGreaterThan(0);
	});
});

describe('validateSnapshot', () => {
	it('accepts a real export', async () => {
		await seedShop();
		const snapshot = await parsed();
		expect(() => validateSnapshot(snapshot)).not.toThrow();
	});

	it.each<[string, (s: any) => void, RegExp]>([
		['missing table', (s) => delete s.data.bikes, /"bikes"/],
		['float cents', (s) => (s.data.work_order_items[0].unit_price_cents = 35.5), /whole cents/],
		['bad status', (s) => (s.data.work_orders[0].status = 'weird'), /status/],
		['orphan bike', (s) => (s.data.bikes[0].customer_id = 'nope'), /missing customers/],
		['duplicate id', (s) => s.data.customers.push({ ...s.data.customers[0] }), /repeats id/],
		['bad ledger date', (s) => (s.data.bike_components[0].last_serviced_date = '2026-13-40'), /YYYY-MM-DD/],
		['newer schema', (s) => (s.version = 999), /newer app/]
	])('rejects %s', async (_name, mutate, message) => {
		await seedShop();
		const snapshot = JSON.parse(JSON.stringify(await parsed()));
		mutate(snapshot);
		expect(() => validateSnapshot(snapshot)).toThrow(SnapshotValidationError);
		expect(() => validateSnapshot(snapshot)).toThrow(message);
	});

	it('rejects non-objects', () => {
		expect(() => validateSnapshot(null)).toThrow(SnapshotValidationError);
		expect(() => validateSnapshot([])).toThrow(SnapshotValidationError);
	});
});

describe('restoreBackup', () => {
	it('restores into a wiped database and notifies once', async () => {
		await seedShop();
		const json = await createBackupJson();
		await clearLocalDatabase();
		expect(queryRows('SELECT id FROM customers')).toEqual([]);

		const listener = vi.fn();
		const off = onLocalWrite(listener);
		await restoreBackup(json, 'pull:self', 'Self');
		off();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana' }]);
		expect(queryRows('SELECT unit_price_cents, quantity FROM work_order_items')).toEqual([
			{ unit_price_cents: 3555, quantity: 2 }
		]);
		expect(queryRows('SELECT component_type FROM bike_components')).toEqual([{ component_type: 'chain' }]);
	});

	it('leaves existing data untouched and does not notify when the file is invalid', async () => {
		await seedShop();
		const listener = vi.fn();
		const off = onLocalWrite(listener);
		await expect(restoreBackup('not json', 'pull:self', 'Self')).rejects.toThrow(/valid JSON/);
		await expect(restoreBackup('{"version":1,"data":{}}', 'pull:self', 'Self')).rejects.toThrow(SnapshotValidationError);
		off();
		expect(listener).not.toHaveBeenCalled();
		expect(queryRows('SELECT id FROM customers')).toHaveLength(1);
	});

	it('rolls back the whole restore when a write fails mid-way', async () => {
		await seedShop();
		const snapshot = await parsed();
		// Passes validation but breaks UNIQUE (bike_id, component_type) in the database, after the deletes ran.
		snapshot.data.bike_components.push({ ...snapshot.data.bike_components[0], id: 'dup' });
		await expect(restoreBackup(JSON.stringify(snapshot), 'pull:self', 'Self')).rejects.toThrow();
		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana' }]);
		expect(queryRows('SELECT id FROM work_orders')).toHaveLength(1);
	});
});

describe('clearLocalDatabase / pending count', () => {
	it('wipes shop data but keeps the outbox, and counts unsynced entries', async () => {
		await seedShop();
		const before = await countPendingOutbox();
		expect(before).toBeGreaterThan(0);
		await clearLocalDatabase();
		expect(queryRows('SELECT id FROM bikes')).toEqual([]);
		expect(await countPendingOutbox()).toBe(before);

		const tip = (queryRows('SELECT MAX(seq) AS tip FROM sync_outbox')[0].tip as number) ?? 0;
		db.exec("INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq) VALUES ('relay:dropbox', 'Dropbox', ?)", {
			bind: [tip]
		});
		expect(await countPendingOutbox()).toBe(0);
	});
});
