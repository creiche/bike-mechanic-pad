import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from '../migrate';

// Run repository SQL against real in-memory SQLite for deterministic behavior.
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

import {
	acknowledgeSync,
	appendMutation,
	exportSnapshot,
	getSyncDelta,
	importSnapshot,
	pruneStaleOutboxLogs,
	type DatabaseSnapshot
} from './sync';
import { createBike, createCustomer } from '../repositories';
import { createWorkOrder } from './workOrders';

const sqlite3 = await sqlite3InitModule();

const queryRows = (sql: string, bind: BindingSpec = []) =>
	db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }) as Array<Record<string, unknown>>;

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
	db.exec('PRAGMA foreign_keys = ON;');
	migrate(db as unknown as Parameters<typeof migrate>[0]);
});

describe('sync repository', () => {
	it('appendMutation inserts and returns a row including seq', async () => {
		const row = await appendMutation({
			entity_type: 'work_order',
			entity_id: 'wo-1',
			action: 'INSERT',
			payload: { status: 'open' }
		});

		expect(row.seq).toBe(1);
		expect(row.entity_id).toBe('wo-1');
		expect(queryRows('SELECT seq, entity_id FROM sync_outbox ORDER BY seq')).toEqual([
			{ seq: 1, entity_id: 'wo-1' }
		]);
	});

	it('getSyncDelta respects peer cursor and ordering', async () => {
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-1', action: 'INSERT', payload: { n: 1 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-2', action: 'INSERT', payload: { n: 2 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-3', action: 'INSERT', payload: { n: 3 } });

		await acknowledgeSync('peer-a', 'Peer A', 2);
		const { deltas, peer } = await getSyncDelta('peer-a');

		expect(peer?.last_synced_seq).toBe(2);
		expect(deltas.map((row) => row.entity_id)).toEqual(['wo-3']);
		expect(deltas.map((row) => row.seq)).toEqual([3]);
	});

	it('acknowledgeSync never decreases last_synced_seq', async () => {
		await acknowledgeSync('peer-a', 'Peer A', 10);
		await acknowledgeSync('peer-a', 'Peer A', 3);

		const [peer] = queryRows('SELECT last_synced_seq FROM peer_sync_state WHERE peer_id = ?', ['peer-a']);
		expect(peer.last_synced_seq).toBe(10);
	});

	it('pruneStaleOutboxLogs prunes only safe old rows when active peers exist', async () => {
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e1', 'work_order', 'wo-1', 'INSERT', '{}', '2020-01-01T00:00:00.000Z')"
		);
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e2', 'work_order', 'wo-2', 'INSERT', '{}', '2020-01-02T00:00:00.000Z')"
		);
		db.exec(
			"INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at) VALUES ('peer-a', 'Peer A', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
		);

		const deleted = await pruneStaleOutboxLogs(30, 30);

		expect(deleted).toBe(1);
		expect(queryRows('SELECT id FROM sync_outbox ORDER BY seq')).toEqual([{ id: 'e2' }]);
	});

	it('pruneStaleOutboxLogs uses retention-only pruning when no active peers exist', async () => {
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e1', 'work_order', 'wo-1', 'INSERT', '{}', '2020-01-01T00:00:00.000Z')"
		);
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e2', 'work_order', 'wo-2', 'INSERT', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
		);
		db.exec(
			"INSERT INTO peer_sync_state (peer_id, peer_name, last_synced_seq, last_seen_at) VALUES ('peer-old', 'Old Peer', 999, '2020-01-01T00:00:00.000Z')"
		);

		const deleted = await pruneStaleOutboxLogs(30, 30);

		expect(deleted).toBe(1);
		expect(queryRows('SELECT id FROM sync_outbox ORDER BY seq')).toEqual([{ id: 'e2' }]);
	});

	it('exportSnapshot returns domain data tables', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
		await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Noisy drivetrain',
			items: [{ item_type: 'labor', description: 'Tune', quantity: 1, unit_price_cents: 5000 }]
		});

		const snapshot = await exportSnapshot();

		expect(snapshot.version).toBeGreaterThanOrEqual(1);
		expect(snapshot.data.customers).toHaveLength(1);
		expect(snapshot.data.bikes).toHaveLength(1);
		expect(snapshot.data.work_orders).toHaveLength(1);
		expect(snapshot.data.work_order_items).toHaveLength(1);
	});

	it('importSnapshot replaces local data and updates self cursor to outbox tip', async () => {
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-1', action: 'INSERT', payload: { n: 1 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-2', action: 'INSERT', payload: { n: 2 } });

		const snapshot: DatabaseSnapshot = {
			version: 4,
			exported_at: '2026-11-07T00:00:00.000Z',
			data: {
				customers: [
					{
						id: 'c-snap',
						name: 'Snapshot Customer',
						phone: null,
						email: null,
						notes: null,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				],
				bikes: [
					{
						id: 'b-snap',
						customer_id: 'c-snap',
						brand: 'Surly',
						model: 'Cross-Check',
						year: null,
						color: null,
						serial_number: null,
						notes: null,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				],
				work_orders: [
					{
						id: 'wo-snap',
						bike_id: 'b-snap',
						status: 'open',
						issue_summary: 'Snapshot issue',
						notes: null,
						total_cents: 2500,
						created_at: '2026-11-07T00:00:00.000Z',
						updated_at: '2026-11-07T00:00:00.000Z'
					}
				],
				work_order_items: [
					{
						id: 'woi-snap',
						work_order_id: 'wo-snap',
						item_type: 'part',
						description: 'Chain',
						quantity: 1,
						unit_price_cents: 2500,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				]
			}
		};

		await importSnapshot(snapshot, 'self-device', 'My Device');

		expect(queryRows('SELECT id FROM customers ORDER BY id')).toEqual([{ id: 'c-snap' }]);
		expect(queryRows('SELECT id FROM bikes ORDER BY id')).toEqual([{ id: 'b-snap' }]);
		expect(queryRows('SELECT id FROM work_orders ORDER BY id')).toEqual([{ id: 'wo-snap' }]);
		expect(queryRows('SELECT id FROM work_order_items ORDER BY id')).toEqual([{ id: 'woi-snap' }]);
		expect(queryRows('SELECT peer_name, last_synced_seq FROM peer_sync_state WHERE peer_id = ?', ['self-device']))
			.toEqual([{ peer_name: 'My Device', last_synced_seq: 2 }]);
	});

	it('importSnapshot resets self cursor down to current tip when previous cursor is higher', async () => {
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-1', action: 'INSERT', payload: { n: 1 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-2', action: 'INSERT', payload: { n: 2 } });
		await acknowledgeSync('self-device', 'Before Import', 100);

		const snapshot: DatabaseSnapshot = {
			version: 4,
			exported_at: '2026-11-07T00:00:00.000Z',
			data: {
				customers: [
					{
						id: 'c-snap-2',
						name: 'Snapshot Customer 2',
						phone: null,
						email: null,
						notes: null,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				],
				bikes: [
					{
						id: 'b-snap-2',
						customer_id: 'c-snap-2',
						brand: 'Trek',
						model: 'Checkpoint',
						year: null,
						color: null,
						serial_number: null,
						notes: null,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				],
				work_orders: [
					{
						id: 'wo-snap-2',
						bike_id: 'b-snap-2',
						status: 'open',
						issue_summary: 'Snapshot issue 2',
						notes: null,
						total_cents: 1000,
						created_at: '2026-11-07T00:00:00.000Z',
						updated_at: '2026-11-07T00:00:00.000Z'
					}
				],
				work_order_items: [
					{
						id: 'woi-snap-2',
						work_order_id: 'wo-snap-2',
						item_type: 'part',
						description: 'Tube',
						quantity: 1,
						unit_price_cents: 1000,
						created_at: '2026-11-07T00:00:00.000Z'
					}
				]
			}
		};

		await importSnapshot(snapshot, 'self-device', 'My Device');

		expect(queryRows('SELECT peer_name, last_synced_seq FROM peer_sync_state WHERE peer_id = ?', ['self-device']))
			.toEqual([{ peer_name: 'My Device', last_synced_seq: 2 }]);
	});
});
