import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from '../migrate';

// Use an in-memory SQLite database so repository SQL runs against the real engine.
type TestDb = { exec(sql: string, options?: Record<string, unknown>): unknown };
let db: TestDb;

vi.mock('../client', () => {
	const exec = (sql: string, options: { bind?: BindingSpec; rowMode?: string; returnValue?: string } = {}) =>
		Promise.resolve(db.exec(sql, options));
	return {
		openDatabase: async () => ({ exec }),
		selectRows: async (sql: string, bind: BindingSpec = []) =>
			db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }),
		runQuery: (sql: string, bind: BindingSpec = []) => exec(sql, { bind })
	};
});

import { createBike, createCustomer } from '../repositories';
import { onLocalWrite } from '../localWrites';
import { createWorkOrder } from './workOrders';

const sqlite3 = await sqlite3InitModule();

const queryRows = (sql: string, bind: BindingSpec = []) =>
	db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }) as Array<Record<string, unknown>>;

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

describe('createWorkOrder', () => {
	it('notifies local-write listeners once on success and not on a rolled-back write', async () => {
		const customer = await createCustomer({ name: 'Ari' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Surly', model: 'Midnight Special' });
		const listener = vi.fn();
		const off = onLocalWrite(listener);

		await expect(
			createWorkOrder({
				bike_id: bike.id,
				issue_summary: 'Brake rub',
				items: [{ item_type: 'part', description: 'Bolt', quantity: 0, unit_price_cents: 300 }]
			})
		).rejects.toThrow();
		expect(listener).not.toHaveBeenCalled();

		await createWorkOrder({ bike_id: bike.id, issue_summary: 'Brake rub', items: [] });
		expect(listener).toHaveBeenCalledOnce();

		off();
	});

	it('creates work order and items, computes total_cents, and writes an outbox event atomically', async () => {
		const customer = await createCustomer({ name: 'Ari' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Surly', model: 'Midnight Special' });

		const workOrder = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Shifting skips under load',
			notes: 'Check derailleur hanger alignment',
			items: [
				{ item_type: 'labor', description: 'Tune drivetrain', quantity: 2, unit_price_cents: 4500 },
				{ item_type: 'part', description: 'Shift cable', quantity: 1, unit_price_cents: 1200 }
			]
		});

		expect(workOrder.total_cents).toBe(10200);
		expect(workOrder.items).toHaveLength(2);
		expect(workOrder.status).toBe('open');

		const outboxRows = queryRows('SELECT * FROM sync_outbox WHERE entity_id = ?', [workOrder.id]);
		expect(outboxRows).toHaveLength(1);
		expect(outboxRows[0].entity_type).toBe('work_order');
		expect(outboxRows[0].action).toBe('INSERT');
	});

	it('rolls back all writes when an item is invalid', async () => {
		const customer = await createCustomer({ name: 'Ari' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Surly', model: 'Midnight Special' });

		await expect(
			createWorkOrder({
				bike_id: bike.id,
				issue_summary: 'Brake rub',
				items: [{ item_type: 'part', description: 'Rotor bolt', quantity: 0, unit_price_cents: 300 }]
			})
		).rejects.toThrow('quantity must be greater than zero');

		expect(queryRows('SELECT id FROM work_orders')).toHaveLength(0);
		expect(queryRows('SELECT id FROM work_order_items')).toHaveLength(0);
		expect(queryRows("SELECT id FROM sync_outbox WHERE entity_type = 'work_order'")).toHaveLength(0);
	});

	it('rolls back all writes when SQL fails after transaction begins', async () => {
		await expect(
			createWorkOrder({
				bike_id: 'missing-bike-id',
				issue_summary: 'Will fail FK check',
				items: [{ item_type: 'labor', description: 'Basic tune', quantity: 1, unit_price_cents: 5000 }]
			})
		).rejects.toThrow();

		expect(queryRows('SELECT id FROM work_orders')).toHaveLength(0);
		expect(queryRows('SELECT id FROM work_order_items')).toHaveLength(0);
		expect(queryRows('SELECT id FROM sync_outbox')).toHaveLength(0);
	});

	it('rejects unsafe integer totals for money math', async () => {
		const customer = await createCustomer({ name: 'Ari' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Surly', model: 'Midnight Special' });

		await expect(
			createWorkOrder({
				bike_id: bike.id,
				issue_summary: 'Huge invoice edge case',
				items: [
					{
						item_type: 'labor',
						description: 'Impossible diagnostic marathon',
						quantity: Number.MAX_SAFE_INTEGER,
						unit_price_cents: 2
					}
				]
			})
		).rejects.toThrow('safe integer');

		expect(queryRows('SELECT id FROM work_orders')).toHaveLength(0);
		expect(queryRows('SELECT id FROM work_order_items')).toHaveLength(0);
		expect(queryRows("SELECT id FROM sync_outbox WHERE entity_type = 'work_order'")).toHaveLength(0);
	});
});
