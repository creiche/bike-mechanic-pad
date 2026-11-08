import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { migrate } from './migrate';

// The real client talks to a browser worker with OPFS storage. For tests we replace it with a fresh
// in-memory SQLite database (same engine, same schema, same PRAGMA) so the repository SQL is real.
type TestDb = { exec(sql: string, options?: Record<string, unknown>): unknown };
let db: TestDb;

vi.mock('./client', () => {
	const exec = (sql: string, options: { bind?: BindingSpec; rowMode?: string; returnValue?: string } = {}) =>
		Promise.resolve(db.exec(sql, options));
	return {
		openDatabase: async () => ({ exec }),
		runQuery: (sql: string, bind: BindingSpec = []) => exec(sql, { bind })
	};
});

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
	createBike,
	createCustomer,
	deleteCustomer,
	getBikesForCustomer,
	getCustomers
} from './repositories';

const sqlite3 = await sqlite3InitModule();

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

describe('customers and bikes', () => {
	it('creates a customer with a client-generated UUID and trims the name', async () => {
		const customer = await createCustomer({ name: '  Miguel Rios  ' });

		expect(customer.name).toBe('Miguel Rios');
		expect(customer.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await getCustomers()).toHaveLength(1);
	});

	it('rejects a blank customer name', async () => {
		await expect(createCustomer({ name: '   ' })).rejects.toThrow('Customer name is required.');
	});

	it('rejects a bike without brand and model', async () => {
		const customer = await createCustomer({ name: 'Ana' });

		await expect(createBike({ customer_id: customer.id, brand: 'Trek', model: ' ' })).rejects.toThrow(
			'Bike brand and model are required.'
		);
	});

	it('only lists bikes that belong to the given customer', async () => {
		const ana = await createCustomer({ name: 'Ana' });
		const ben = await createCustomer({ name: 'Ben' });
		await createBike({ customer_id: ana.id, brand: 'Trek', model: 'Domane' });
		await createBike({ customer_id: ben.id, brand: 'Giant', model: 'Defy' });

		const bikes = await getBikesForCustomer(ana.id);

		expect(bikes.map((bike) => bike.model)).toEqual(['Domane']);
	});

	it('refuses a bike for a customer that does not exist', async () => {
		await expect(createBike({ customer_id: 'missing', brand: 'Trek', model: 'Domane' })).rejects.toThrow();
	});

	it('deleting a customer also deletes their bikes (ON DELETE CASCADE)', async () => {
		const ana = await createCustomer({ name: 'Ana' });
		const ben = await createCustomer({ name: 'Ben' });
		await createBike({ customer_id: ana.id, brand: 'Trek', model: 'Domane' });
		await createBike({ customer_id: ben.id, brand: 'Giant', model: 'Defy' });

		await deleteCustomer(ana.id);

		expect(await getBikesForCustomer(ana.id)).toEqual([]);
		expect(await getBikesForCustomer(ben.id)).toHaveLength(1);
	});

	it('records customer and bike mutations in the sync outbox', async () => {
		const ana = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: ana.id, brand: 'Trek', model: 'Domane', year: 2022 });
		await deleteCustomer(ana.id);

		const rows = db.exec('SELECT entity_type, entity_id, action, payload FROM sync_outbox ORDER BY seq', {
			rowMode: 'object',
			returnValue: 'resultRows'
		}) as Array<{ entity_type: string; entity_id: string; action: string; payload: string }>;

		expect(rows.map((row) => [row.entity_type, row.entity_id, row.action])).toEqual([
			['customer', ana.id, 'INSERT'],
			['bike', bike.id, 'INSERT'],
			['customer', ana.id, 'DELETE']
		]);
		expect(JSON.parse(rows[1].payload)).toMatchObject({ customer_id: ana.id, brand: 'Trek', year: 2022 });
	});

	it('writes no outbox entry when the domain insert fails', async () => {
		await expect(createBike({ customer_id: 'missing', brand: 'Trek', model: 'Domane' })).rejects.toThrow();

		expect(db.exec('SELECT seq FROM sync_outbox', { returnValue: 'resultRows' })).toEqual([]);
	});
});
