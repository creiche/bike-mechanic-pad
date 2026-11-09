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
		runQuery: (sql: string, bind: BindingSpec = []) => exec(sql, { bind })
	};
});

import { createBike, createCustomer } from '../repositories';
import { onLocalWrite } from '../localWrites';
import { applyRemoteDeltas, exportSnapshot, importSnapshot, type DatabaseSnapshot } from './sync';
import { addWorkOrderItem, createWorkOrder, updateWorkOrder } from './workOrders';
import {
	createServiceMenuItem,
	filterServiceMenu,
	listServiceMenuItems,
	setServiceMenuItemArchived,
	updateServiceMenuItem
} from './serviceMenu';

const sqlite3 = await sqlite3InitModule();
const queryRows = (sql: string, bind: BindingSpec = []) =>
	db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }) as Array<Record<string, unknown>>;

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

describe('service menu', () => {
	it('seeds staples with integer-cent prices', async () => {
		const items = await listServiceMenuItems();
		const bleed = items.find((item) => item.name === 'Hydraulic Brake Bleed');
		expect(bleed).toMatchObject({ default_price_cents: 3500, component_tag: 'brake_bleed', item_type: 'labor' });
		expect(items.every((item) => Number.isInteger(item.default_price_cents))).toBe(true);
	});

	it('filters by every word, case-insensitively', async () => {
		const items = await listServiceMenuItems();
		expect(filterServiceMenu(items, 'BRAKE bleed').map((item) => item.name)).toEqual(['Hydraulic Brake Bleed']);
		expect(filterServiceMenu(items, 'zzz')).toEqual([]);
		expect(filterServiceMenu(items, '')).toHaveLength(items.length);
	});

	it('create/update/archive queue outbox events and notify once each', async () => {
		const listener = vi.fn();
		const off = onLocalWrite(listener);
		const created = await createServiceMenuItem({
			category: 'labor',
			name: 'Wheel True',
			default_price_cents: 2500,
			item_type: 'labor'
		});
		await updateServiceMenuItem(created.id, { ...created, default_price_cents: 3000 });
		await setServiceMenuItemArchived(created.id, true);
		off();

		expect(listener).toHaveBeenCalledTimes(3);
		expect(queryRows("SELECT action FROM sync_outbox WHERE entity_type = 'service_menu_item' ORDER BY seq")).toEqual([
			{ action: 'INSERT' },
			{ action: 'UPDATE' },
			{ action: 'UPDATE' }
		]);
		expect((await listServiceMenuItems()).some((item) => item.id === created.id)).toBe(false);
		expect((await listServiceMenuItems(true)).find((item) => item.id === created.id)).toMatchObject({
			default_price_cents: 3000
		});
	});

	it('rejects bad input', async () => {
		const base = { category: 'labor', name: 'x', default_price_cents: 100, item_type: 'labor' } as const;
		await expect(createServiceMenuItem({ ...base, name: ' ' })).rejects.toThrow(/name/);
		await expect(createServiceMenuItem({ ...base, default_price_cents: 1.5 })).rejects.toThrow(/cents/);
		await expect(createServiceMenuItem({ ...base, default_price_cents: -1 })).rejects.toThrow(/cents/);
		// @ts-expect-error invalid tag on purpose
		await expect(createServiceMenuItem({ ...base, component_tag: 'nope' })).rejects.toThrow(/component/);
	});

	it('a quick-added tagged preset stamps the component ledger on completion', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
		const order = await createWorkOrder({ bike_id: bike.id, issue_summary: 'Brakes', items: [] });
		const preset = (await listServiceMenuItems()).find((item) => item.name === 'Hydraulic Brake Bleed')!;

		const updated = await addWorkOrderItem(order.id, {
			item_type: preset.item_type,
			description: preset.name,
			quantity: 1,
			unit_price_cents: preset.default_price_cents,
			component_type: preset.component_tag
		});
		expect(updated.total_cents).toBe(3500);

		await updateWorkOrder(order.id, { status: 'completed' });
		expect(queryRows('SELECT component_type, work_order_id FROM bike_components')).toEqual([
			{ component_type: 'brake_bleed', work_order_id: order.id }
		]);
	});

	it('round-trips through snapshots and keeps the menu when an old snapshot has none', async () => {
		const created = await createServiceMenuItem({
			category: 'part',
			name: 'Valve Stem',
			default_price_cents: 450,
			item_type: 'part'
		});
		const snapshot = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		expect(snapshot.data.service_menu_items?.some((item) => item.id === created.id)).toBe(true);

		db.exec('DELETE FROM service_menu_items');
		await importSnapshot(snapshot, 'self');
		expect((await listServiceMenuItems()).some((item) => item.id === created.id)).toBe(true);

		delete snapshot.data.service_menu_items;
		await importSnapshot(snapshot, 'self');
		expect((await listServiceMenuItems()).some((item) => item.id === created.id)).toBe(true);
	});

	it('applies remote menu deltas last-write-wins', async () => {
		const payload = (price: number, updated_at: string) =>
			JSON.stringify({
				id: 'svc-seed-chain-install', category: 'labor', name: 'Chain Install', default_price_cents: price,
				item_type: 'labor', component_tag: 'chain', archived_at: null, created_at: '1970-01-01T00:00:00.000Z', updated_at
			});
		const delta = (seq: number, price: number, at: string) => ({
			seq, id: `d${seq}`, entity_type: 'service_menu_item', entity_id: 'svc-seed-chain-install',
			action: 'UPDATE', payload: payload(price, at), created_at: at
		});
		await applyRemoteDeltas('pull:x', 'X', [
			delta(1, 2000, '2026-01-02T00:00:00.000Z'),
			delta(2, 1800, '2026-01-01T00:00:00.000Z')
		]);
		expect(queryRows("SELECT default_price_cents FROM service_menu_items WHERE id = 'svc-seed-chain-install'")).toEqual([
			{ default_price_cents: 2000 }
		]);
	});
});
