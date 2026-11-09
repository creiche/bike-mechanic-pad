import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from '../migrate';

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

import { todayLocalDate } from '../../domain/componentTypes';
import { onLocalWrite } from '../localWrites';
import { createBike, createCustomer, deleteBike } from '../repositories';
import { deleteBikeComponent, getBikeComponents, logComponentService } from './bikeComponents';
import {
	addWorkOrderItem,
	countWorkOrdersByStatus,
	createWorkOrder,
	deleteWorkOrder,
	getWorkOrder,
	listWorkOrders,
	removeWorkOrderItem,
	updateWorkOrder,
	updateWorkOrderItem
} from './workOrders';

const sqlite3 = await sqlite3InitModule();

const queryRows = (sql: string, bind: BindingSpec = []) =>
	db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }) as Array<Record<string, unknown>>;
const outbox = () =>
	queryRows('SELECT entity_type, action, payload FROM sync_outbox ORDER BY seq') as Array<{
		entity_type: string;
		action: string;
		payload: string;
	}>;

async function seedBike() {
	const customer = await createCustomer({ name: 'Ari' });
	const bike = await createBike({ customer_id: customer.id, brand: 'Surly', model: 'Midnight Special' });
	return { customer, bike };
}

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

describe('line items', () => {
	it('adds, edits and removes items with totals recomputed in integer cents', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({ bike_id: bike.id, issue_summary: 'Tune-up', items: [] });

		let current = await addWorkOrderItem(order.id, {
			item_type: 'labor',
			description: 'Tune',
			quantity: 3,
			unit_price_cents: 1999
		});
		expect(current.total_cents).toBe(5997);

		current = await addWorkOrderItem(order.id, {
			item_type: 'part',
			description: 'Chain',
			quantity: 1,
			unit_price_cents: 3550,
			component_type: 'chain'
		});
		expect(current.total_cents).toBe(9547);
		expect(current.items.map((item) => item.description)).toEqual(['Tune', 'Chain']);

		current = await updateWorkOrderItem(current.items[0].id, { quantity: 2, unit_price_cents: 4500 });
		expect(current.total_cents).toBe(12550);

		current = await removeWorkOrderItem(current.items[1].id);
		expect(current.total_cents).toBe(9000);
		expect(current.items).toHaveLength(1);
		expect(queryRows('SELECT total_cents FROM work_orders')).toEqual([{ total_cents: 9000 }]);
	});

	it('queues the full work order (with items) on every change and notifies listeners', async () => {
		const { bike } = await seedBike();
		const listener = vi.fn();
		const off = onLocalWrite(listener);

		const order = await createWorkOrder({ bike_id: bike.id, issue_summary: 'Brakes', items: [] });
		const added = await addWorkOrderItem(order.id, {
			item_type: 'part',
			description: 'Pads',
			quantity: 2,
			unit_price_cents: 2500,
			component_type: 'brake_pads'
		});
		await removeWorkOrderItem(added.items[0].id);

		expect(listener).toHaveBeenCalledTimes(3);
		const events = outbox().filter((row) => row.entity_type === 'work_order');
		expect(events.map((row) => row.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
		expect(JSON.parse(events[1].payload)).toMatchObject({
			id: order.id,
			total_cents: 5000,
			items: [{ description: 'Pads', quantity: 2, unit_price_cents: 2500, component_type: 'brake_pads' }]
		});
		expect(JSON.parse(events[2].payload)).toMatchObject({ total_cents: 0, items: [] });

		off();
	});

	it('rejects invalid items without changing the order or the outbox', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Tune',
			items: [{ item_type: 'labor', description: 'Tune', quantity: 1, unit_price_cents: 5000 }]
		});
		const before = outbox().length;
		const listener = vi.fn();
		const off = onLocalWrite(listener);

		await expect(
			addWorkOrderItem(order.id, { item_type: 'part', description: 'x', quantity: 1, unit_price_cents: 12.5 })
		).rejects.toThrow('safe integer');
		await expect(
			addWorkOrderItem(order.id, { item_type: 'part', description: 'x', quantity: 1, unit_price_cents: 100, component_type: 'flux' as never })
		).rejects.toThrow('Unknown component type');
		await expect(updateWorkOrderItem(order.items[0].id, { quantity: 0 })).rejects.toThrow('greater than zero');
		await expect(removeWorkOrderItem('missing')).rejects.toThrow('Line item not found.');

		expect(outbox()).toHaveLength(before);
		expect(listener).not.toHaveBeenCalled();
		expect((await getWorkOrder(order.id))?.total_cents).toBe(5000);

		off();
	});

	it('freezes line items on completed and cancelled orders until reopened', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Tune',
			items: [{ item_type: 'labor', description: 'Tune', quantity: 1, unit_price_cents: 5000 }]
		});

		await updateWorkOrder(order.id, { status: 'completed' });
		await expect(
			addWorkOrderItem(order.id, { item_type: 'part', description: 'Late', quantity: 1, unit_price_cents: 100 })
		).rejects.toThrow('Reopen');
		await expect(removeWorkOrderItem(order.items[0].id)).rejects.toThrow('Reopen');

		await updateWorkOrder(order.id, { status: 'in_progress' });
		const reopened = await addWorkOrderItem(order.id, {
			item_type: 'part',
			description: 'Late',
			quantity: 1,
			unit_price_cents: 100
		});
		expect(reopened.total_cents).toBe(5100);
	});
});

describe('completing a work order', () => {
	it('stamps tagged components with today and the work order id, in the same transaction', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Drivetrain refresh',
			items: [
				{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' },
				{ item_type: 'part', description: 'Cassette', quantity: 1, unit_price_cents: 6000, component_type: 'cassette' },
				{ item_type: 'labor', description: 'Install chain', quantity: 1, unit_price_cents: 2000, component_type: 'chain' },
				{ item_type: 'labor', description: 'Wash bike', quantity: 1, unit_price_cents: 1000 }
			]
		});
		expect(await getBikeComponents(bike.id)).toEqual([]);

		await updateWorkOrder(order.id, { status: 'ready_for_pickup' });
		expect(await getBikeComponents(bike.id)).toEqual([]);

		await updateWorkOrder(order.id, { status: 'completed' });

		const components = await getBikeComponents(bike.id);
		expect(components.map((component) => component.component_type)).toEqual(['cassette', 'chain']);
		for (const component of components) {
			expect(component).toMatchObject({ last_serviced_date: todayLocalDate(), work_order_id: order.id });
		}

		const events = outbox();
		expect(events.filter((row) => row.entity_type === 'bike_component').map((row) => row.action)).toEqual([
			'INSERT',
			'INSERT'
		]);
		const lastWorkOrderEvent = events.findLast((row) => row.entity_type === 'work_order');
		const firstComponentEvent = events.find((row) => row.entity_type === 'bike_component');
		expect(events.indexOf(lastWorkOrderEvent!)).toBeLessThan(events.indexOf(firstComponentEvent!));
	});

	it('updates an existing ledger row instead of adding a second one', async () => {
		const { bike } = await seedBike();
		await logComponentService({ bike_id: bike.id, component_type: 'chain', last_serviced_date: '2024-01-15' });
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'New chain',
			items: [{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' }]
		});

		await updateWorkOrder(order.id, { status: 'completed' });

		const components = await getBikeComponents(bike.id);
		expect(components).toHaveLength(1);
		expect(components[0]).toMatchObject({ last_serviced_date: todayLocalDate(), work_order_id: order.id });
		expect(outbox().filter((row) => row.entity_type === 'bike_component').map((row) => row.action)).toEqual([
			'INSERT',
			'UPDATE'
		]);
	});

	it('stamps components when an order is created already completed', async () => {
		const { bike } = await seedBike();

		await createWorkOrder({
			bike_id: bike.id,
			status: 'completed',
			issue_summary: 'Walk-in fork service',
			items: [{ item_type: 'labor', description: 'Fork lowers', quantity: 1, unit_price_cents: 9000, component_type: 'fork_service' }]
		});

		expect((await getBikeComponents(bike.id)).map((component) => component.component_type)).toEqual(['fork_service']);
	});

	it('does not stamp on cancel, on untagged items, or when re-saving an already completed order', async () => {
		const { bike } = await seedBike();
		const tagged = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Pads',
			items: [{ item_type: 'part', description: 'Pads', quantity: 1, unit_price_cents: 2000, component_type: 'brake_pads' }]
		});
		await updateWorkOrder(tagged.id, { status: 'cancelled' });
		expect(await getBikeComponents(bike.id)).toEqual([]);

		const untagged = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Wash',
			items: [{ item_type: 'labor', description: 'Wash', quantity: 1, unit_price_cents: 1000 }]
		});
		await updateWorkOrder(untagged.id, { status: 'completed' });
		expect(await getBikeComponents(bike.id)).toEqual([]);

		await updateWorkOrder(tagged.id, { status: 'completed' });
		const before = outbox().length;
		await updateWorkOrder(tagged.id, { notes: 'Called customer' });
		expect(outbox().length - before).toBe(1);
	});

	it('rolls back the status change when stamping fails', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Chain',
			items: [{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' }]
		});
		db.exec("UPDATE work_order_items SET component_type = 'bogus'");
		const before = outbox().length;

		await expect(updateWorkOrder(order.id, { status: 'completed' })).rejects.toThrow('Unknown component type');

		expect((await getWorkOrder(order.id))?.status).toBe('open');
		expect(outbox()).toHaveLength(before);
	});
});

describe('queries and deletes', () => {
	it('lists work orders with customer and bike labels and filters by status', async () => {
		const { customer, bike } = await seedBike();
		const first = await createWorkOrder({ bike_id: bike.id, issue_summary: 'A', items: [] });
		await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'B',
			items: [{ item_type: 'labor', description: 'Tune', quantity: 1, unit_price_cents: 5000 }]
		});
		await updateWorkOrder(first.id, { status: 'in_progress' });

		const all = await listWorkOrders();
		expect(all).toHaveLength(2);
		expect(all[0]).toMatchObject({
			customer_id: customer.id,
			customer_name: 'Ari',
			bike_brand: 'Surly',
			bike_model: 'Midnight Special'
		});

		const active = await listWorkOrders(['open', 'in_progress']);
		expect(active).toHaveLength(2);
		const inProgress = await listWorkOrders(['in_progress']);
		expect(inProgress.map((row) => row.issue_summary)).toEqual(['A']);
		expect(await listWorkOrders(['completed'])).toEqual([]);
		expect(all.find((row) => row.issue_summary === 'B')).toMatchObject({ item_count: 1, total_cents: 5000 });
		await expect(listWorkOrders(['bogus' as never])).rejects.toThrow('Invalid work order status');

		expect(await countWorkOrdersByStatus()).toEqual({
			open: 1,
			in_progress: 1,
			ready_for_pickup: 0,
			completed: 0,
			cancelled: 0
		});
	});

	it('deletes a work order with its items, keeps the ledger row but unlinks it, and queues a DELETE', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Chain',
			status: 'completed',
			items: [{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' }]
		});

		await deleteWorkOrder(order.id);

		expect(await getWorkOrder(order.id)).toBeNull();
		expect(queryRows('SELECT id FROM work_order_items')).toEqual([]);
		expect(await getBikeComponents(bike.id)).toMatchObject([{ component_type: 'chain', work_order_id: null }]);
		expect(outbox().at(-1)).toMatchObject({ entity_type: 'work_order', action: 'DELETE' });
	});

	it('rejects updating a missing work order and blank summaries', async () => {
		const { bike } = await seedBike();
		const order = await createWorkOrder({ bike_id: bike.id, issue_summary: 'A', items: [] });

		await expect(updateWorkOrder('missing', { status: 'completed' })).rejects.toThrow('Work order not found.');
		await expect(updateWorkOrder(order.id, { issue_summary: '  ' })).rejects.toThrow('issue summary is required');
		await expect(updateWorkOrder(order.id, { status: 'bogus' as never })).rejects.toThrow('Invalid work order status');
	});
});

describe('bike component ledger', () => {
	it('logs a manual entry, validates input, and queues INSERT/DELETE', async () => {
		const { bike } = await seedBike();
		const listener = vi.fn();
		const off = onLocalWrite(listener);

		await expect(
			logComponentService({ bike_id: bike.id, component_type: 'flux', last_serviced_date: '2025-01-01' })
		).rejects.toThrow('Unknown component type');
		await expect(
			logComponentService({ bike_id: bike.id, component_type: 'chain', last_serviced_date: '2025-02-30' })
		).rejects.toThrow('valid YYYY-MM-DD');
		await expect(
			logComponentService({ bike_id: 'missing', component_type: 'chain', last_serviced_date: '2025-01-01' })
		).rejects.toThrow();
		expect(listener).not.toHaveBeenCalled();

		const row = await logComponentService({
			bike_id: bike.id,
			component_type: 'bottom_bracket',
			last_serviced_date: '2025-03-04',
			notes: 'Greased'
		});
		expect(row).toMatchObject({ last_serviced_date: '2025-03-04', work_order_id: null, notes: 'Greased' });

		await deleteBikeComponent(row.id);
		expect(await getBikeComponents(bike.id)).toEqual([]);
		expect(listener).toHaveBeenCalledTimes(2);
		expect(outbox().map((event) => [event.entity_type, event.action])).toEqual([
			['customer', 'INSERT'],
			['bike', 'INSERT'],
			['bike_component', 'INSERT'],
			['bike_component', 'DELETE']
		]);

		off();
	});

	it('cascades with the bike', async () => {
		const { bike } = await seedBike();
		await logComponentService({ bike_id: bike.id, component_type: 'chain', last_serviced_date: '2025-01-01' });

		await deleteBike(bike.id);

		expect(queryRows('SELECT id FROM bike_components')).toEqual([]);
	});
});
