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
		selectRows: async (sql: string, bind: BindingSpec = []) =>
			db.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' }),
		runQuery: (sql: string, bind: BindingSpec = []) => exec(sql, { bind })
	};
});

import {
	acknowledgeSync,
	applyRemoteDeltas,
	appendMutation,
	exportSnapshot,
	getPeerState,
	getSyncDelta,
	importSnapshot,
	pruneStaleOutboxLogs,
	pullPeerId,
	SyncProtocolError,
	type DatabaseSnapshot,
	type OutboxEntry
} from './sync';
import { createBike, createCustomer, deleteCustomer } from '../repositories';
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

	it('importSnapshot replaces local data and points the self cursor before work done after the backup', async () => {
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-1', action: 'INSERT', payload: { n: 1 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-2', action: 'INSERT', payload: { n: 2 } });

		const snapshot: DatabaseSnapshot = {
			version: 4,
			exported_at: '2000-01-01T00:00:00.000Z',
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
			.toEqual([{ peer_name: 'My Device', last_synced_seq: 0 }]);
	});

	it('importSnapshot resets self cursor to the start of history even when the backup is newer than every outbox row', async () => {
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-1', action: 'INSERT', payload: { n: 1 } });
		await appendMutation({ entity_type: 'work_order', entity_id: 'wo-2', action: 'INSERT', payload: { n: 2 } });
		await acknowledgeSync('self-device', 'Before Import', 100);

		const snapshot: DatabaseSnapshot = {
			version: 4,
			exported_at: '2999-01-01T00:00:00.000Z',
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
			.toEqual([{ peer_name: 'My Device', last_synced_seq: 0 }]);
	});
});

const remote = (seq: number, entity_type: string, action: string, entity_id: string, payload: object): OutboxEntry => ({
	seq,
	id: `evt-${seq}`,
	entity_type,
	entity_id,
	action,
	payload: JSON.stringify(payload),
	created_at: '2026-11-07T10:00:00.000Z'
});

const remoteChain = (): OutboxEntry[] => [
	remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana', phone: null, email: null, notes: null }),
	remote(2, 'bike', 'INSERT', 'b1', { id: 'b1', customer_id: 'c1', brand: 'Trek', model: 'Domane' }),
	remote(3, 'work_order', 'INSERT', 'w1', {
		id: 'w1',
		bike_id: 'b1',
		status: 'open',
		issue_summary: 'Squeak',
		notes: null,
		total_cents: 5000,
		items: [{ id: 'i1', item_type: 'labor', description: 'Tune', quantity: 1, unit_price_cents: 5000 }]
	})
];

describe('applyRemoteDeltas', () => {
	it('applies deltas, advances the pull cursor, and does not echo into the outbox', async () => {
		const result = await applyRemoteDeltas(pullPeerId('dev-b'), 'Shop iPad', remoteChain());

		expect(result).toMatchObject({ applied: 3, blocked: false, lastSyncedSeq: 3 });
		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana' }]);
		expect(queryRows('SELECT brand FROM bikes')).toEqual([{ brand: 'Trek' }]);
		expect(queryRows('SELECT total_cents FROM work_orders')).toEqual([{ total_cents: 5000 }]);
		expect(queryRows('SELECT description FROM work_order_items')).toEqual([{ description: 'Tune' }]);
		expect(queryRows('SELECT id FROM sync_outbox')).toEqual([]);
		expect((await getPeerState(pullPeerId('dev-b')))?.last_synced_seq).toBe(3);
	});

	it('is idempotent: replaying the same deltas applies nothing', async () => {
		await applyRemoteDeltas(pullPeerId('dev-b'), 'Shop iPad', remoteChain());
		const replay = await applyRemoteDeltas(pullPeerId('dev-b'), 'Shop iPad', remoteChain());

		expect(replay).toMatchObject({ applied: 0, blocked: false, lastSyncedSeq: 3 });
		expect(queryRows('SELECT id FROM work_order_items')).toHaveLength(1);
	});

	it('keeps the newer work order when an older update arrives (last write wins)', async () => {
		const base = { id: 'w1', bike_id: 'b1', status: 'open', notes: null, total_cents: 0, items: [] };
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', remoteChain().slice(0, 2));
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			remote(3, 'work_order', 'UPDATE', 'w1', { ...base, issue_summary: 'newer', updated_at: '2026-11-07T12:00:00.000Z' })
		]);
		await applyRemoteDeltas(pullPeerId('dev-c'), 'C', [
			remote(1, 'work_order', 'UPDATE', 'w1', { ...base, issue_summary: 'older', updated_at: '2026-11-07T11:00:00.000Z' })
		]);

		expect(queryRows('SELECT issue_summary FROM work_orders')).toEqual([{ issue_summary: 'newer' }]);
	});

	it('keeps the newer customer when an older update arrives (last write wins)', async () => {
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			remote(1, 'customer', 'UPDATE', 'c1', { id: 'c1', name: 'Ana', phone: '555-NEW', updated_at: '2026-11-07T12:00:00.000Z' })
		]);
		await applyRemoteDeltas(pullPeerId('dev-c'), 'C', [
			remote(1, 'customer', 'UPDATE', 'c1', { id: 'c1', name: 'Ana', phone: '555-OLD', updated_at: '2026-11-07T11:00:00.000Z' })
		]);

		expect(queryRows('SELECT phone FROM customers')).toEqual([{ phone: '555-NEW' }]);
	});

	it('keeps the newer bike when an older update arrives (last write wins)', async () => {
		const bike = { id: 'b1', customer_id: 'c1', model: 'Domane' };
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			remoteChain()[0],
			remote(2, 'bike', 'UPDATE', 'b1', { ...bike, brand: 'Trek', updated_at: '2026-11-07T12:00:00.000Z' })
		]);
		await applyRemoteDeltas(pullPeerId('dev-c'), 'C', [
			remote(1, 'bike', 'UPDATE', 'b1', { ...bike, brand: 'Old Brand', updated_at: '2026-11-07T11:00:00.000Z' })
		]);

		expect(queryRows('SELECT brand FROM bikes')).toEqual([{ brand: 'Trek' }]);
	});

	it('local customer and bike edits stamp updated_at and send it in the payload', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
		const { updateCustomer } = await import('../repositories');
		await updateCustomer(customer.id, { name: 'Ana B' });

		const payloads = queryRows("SELECT payload FROM sync_outbox ORDER BY seq").map((r) => JSON.parse(r.payload as string));
		expect(payloads.every((p) => typeof p.updated_at === 'string' && typeof p.created_at === 'string')).toBe(true);
		expect(bike.updated_at).toBe(bike.created_at);
		expect(payloads[2].updated_at >= payloads[0].updated_at).toBe(true);
	});

	it('stops at a delta whose parent is missing, keeps the cursor before it, and retries once the parent arrives', async () => {
		const chain = remoteChain();
		// The bike (seq 2) arrives before its customer (seq 1 was never delivered).
		const first = await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [chain[1], chain[2]]);
		expect(first).toMatchObject({ applied: 0, blocked: true, lastSyncedSeq: 0 });
		expect(queryRows('SELECT id FROM bikes')).toEqual([]);

		const retry = await applyRemoteDeltas(pullPeerId('dev-b'), 'B', chain);
		expect(retry).toMatchObject({ applied: 3, blocked: false, lastSyncedSeq: 3 });
		expect(queryRows('SELECT id FROM work_orders')).toEqual([{ id: 'w1' }]);
	});

	it('drops only the first orphan when told to, then stops at the next one', async () => {
		const orphan = (seq: number) =>
			remote(seq, 'bike', 'INSERT', `b${seq}`, { id: `b${seq}`, customer_id: 'gone', brand: 'Trek', model: 'Domane' });

		const result = await applyRemoteDeltas(
			pullPeerId('dev-b'),
			'B',
			[orphan(1), remote(2, 'customer', 'INSERT', 'c9', { id: 'c9', name: 'Bo' }), orphan(3)],
			{ dropFirstOrphan: true }
		);

		expect(result).toMatchObject({
			applied: 1,
			dropped: 1,
			blocked: true,
			blockedAt: '2026-11-07T10:00:00.000Z',
			lastSyncedSeq: 2
		});
		expect(queryRows('SELECT id FROM customers')).toEqual([{ id: 'c9' }]);
		expect(queryRows('SELECT id FROM bikes')).toEqual([]);
	});

	it('replays a peer after a restore, so rows newer than the backup come back', async () => {
		const peer = pullPeerId('dev-b');
		const older = remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana' });
		const newer = remote(2, 'customer', 'INSERT', 'c2', { id: 'c2', name: 'Bo' });
		await applyRemoteDeltas(peer, 'B', [older]);
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		await applyRemoteDeltas(peer, 'B', [newer]);

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		expect(queryRows('SELECT id FROM customers')).toEqual([{ id: 'c1' }]);

		await applyRemoteDeltas(peer, 'B', [older, newer]);
		expect(queryRows('SELECT id FROM customers ORDER BY id')).toEqual([{ id: 'c1' }, { id: 'c2' }]);
	});

	it('does not bring back a record this device deleted when a restore replays a peer', async () => {
		const peer = pullPeerId('dev-b');
		const created = remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana' });
		await applyRemoteDeltas(peer, 'B', [created]);
		await deleteCustomer('c1');
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		const replay = await applyRemoteDeltas(peer, 'B', [created]);

		expect(replay).toMatchObject({ blocked: false, lastSyncedSeq: 1 });
		expect(queryRows('SELECT id FROM customers')).toEqual([]);
	});

	it('accepts later peer edits to a record a restore brought back', async () => {
		const peer = pullPeerId('dev-b');
		await applyRemoteDeltas(peer, 'B', [remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana' })]);
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		await deleteCustomer('c1');

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		await applyRemoteDeltas(peer, 'B', [
			remote(2, 'customer', 'UPDATE', 'c1', { id: 'c1', name: 'Ana B', updated_at: '2999-01-01T00:00:00.000Z' })
		]);

		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana B' }]);
	});

	it('keeps a restored record when replaying this device history that deleted it', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		await deleteCustomer(customer.id);
		const history = queryRows('SELECT * FROM sync_outbox ORDER BY seq') as unknown as OutboxEntry[];
		const before = history[history.length - 1].seq;

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		const requeued = queryRows('SELECT * FROM sync_outbox WHERE seq > ? ORDER BY seq', [before]) as unknown as OutboxEntry[];
		await applyRemoteDeltas(pullPeerId('dev-self-replay'), 'Self', [...history, ...requeued]);

		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana' }]);
	});

	it('replays this device work whose outbox row was pruned before the restore', async () => {
		await createCustomer({ name: 'Ana' });
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		await createCustomer({ name: 'Bo' });
		const [{ seq: prunedThrough }] = queryRows('SELECT MAX(seq) AS seq FROM sync_outbox');
		await createCustomer({ name: 'Cy' });
		const history = queryRows('SELECT * FROM sync_outbox ORDER BY seq') as unknown as OutboxEntry[];
		db.exec('DELETE FROM sync_outbox WHERE seq <= ?', { bind: [prunedThrough] });

		const self = pullPeerId('dev-self');
		await importSnapshot(backup, self, 'Self');
		expect(queryRows('SELECT name FROM customers')).toEqual([{ name: 'Ana' }]);

		await applyRemoteDeltas(self, 'Self', history);
		expect(queryRows('SELECT name FROM customers ORDER BY name')).toEqual([{ name: 'Ana' }, { name: 'Bo' }, { name: 'Cy' }]);
	});

	const restoredCopy = (createdAt: string) => ({
		...remote(2, 'customer', 'UPDATE', 'c1', { id: 'c1', name: 'Ana', restored: true }),
		created_at: createdAt
	});
	const remoteDelete = (seq: number, id: string, createdAt: string) => ({
		...remote(seq, 'customer', 'DELETE', id, { id }),
		created_at: createdAt
	});
	const localDeletes = () => queryRows("SELECT entity_id FROM sync_outbox WHERE action = 'DELETE'");

	it('lets a restored copy from another device undo an older delete made here', async () => {
		const peer = pullPeerId('dev-b');
		await applyRemoteDeltas(peer, 'B', [remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana' })]);
		await deleteCustomer('c1');

		await applyRemoteDeltas(peer, 'B', [restoredCopy('2999-01-01T00:00:00.000Z')]);

		expect(queryRows('SELECT id FROM customers')).toEqual([{ id: 'c1' }]);
		expect(localDeletes()).toEqual([]);
	});

	it('keeps a delete made here after the restored copy', async () => {
		const peer = pullPeerId('dev-b');
		await applyRemoteDeltas(peer, 'B', [remote(1, 'customer', 'INSERT', 'c1', { id: 'c1', name: 'Ana' })]);
		await deleteCustomer('c1');

		await applyRemoteDeltas(peer, 'B', [restoredCopy('2020-01-01T00:00:00.000Z')]);

		expect(queryRows('SELECT id FROM customers')).toEqual([]);
		expect(localDeletes()).toEqual([{ entity_id: 'c1' }]);
	});

	it('keeps a restored record when another device history holds an older delete, but not a newer one', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		const peer = pullPeerId('dev-b');

		await applyRemoteDeltas(peer, 'B', [remoteDelete(1, customer.id, '2020-01-01T00:00:00.000Z')]);
		expect(queryRows('SELECT id FROM customers')).toEqual([{ id: customer.id }]);

		await applyRemoteDeltas(peer, 'B', [remoteDelete(2, customer.id, '2999-01-01T00:00:00.000Z')]);
		expect(queryRows('SELECT id FROM customers')).toEqual([]);
	});

	it('queues restored rows, parents first, so another device can rebuild from them', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
		const order = await createWorkOrder({
			bike_id: bike.id,
			issue_summary: 'Chain',
			items: [{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3555 }]
		});
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		const before = queryRows('SELECT MAX(seq) AS tip FROM sync_outbox')[0].tip as number;

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');

		const queued = queryRows('SELECT * FROM sync_outbox WHERE seq > ? ORDER BY seq', [before]) as unknown as OutboxEntry[];
		expect(queued.map((row) => row.entity_type).filter((type) => type !== 'service_menu_item')).toEqual([
			'customer',
			'bike',
			'work_order'
		]);

		// Apply them on an empty "other device": the same rows must come out, with the original timestamps.
		db = new sqlite3.oo1.DB(':memory:') as unknown as TestDb;
		db.exec('PRAGMA foreign_keys = ON;');
		migrate(db as unknown as Parameters<typeof migrate>[0]);
		const result = await applyRemoteDeltas(pullPeerId('dev-a'), 'A', queued);

		expect(result).toMatchObject({ blocked: false });
		expect(queryRows('SELECT updated_at FROM customers')).toEqual([{ updated_at: customer.updated_at }]);
		expect(queryRows('SELECT id, total_cents FROM work_orders')).toEqual([{ id: order.id, total_cents: 3555 }]);
		expect(queryRows('SELECT unit_price_cents FROM work_order_items')).toEqual([{ unit_price_cents: 3555 }]);
	});

	it('requeues a delete from the backup that this device has no record of', async () => {
		const backup = JSON.parse(JSON.stringify(await exportSnapshot())) as DatabaseSnapshot;
		backup.data.outbox = [{ ...remote(9, 'customer', 'DELETE', 'gone', { id: 'gone' }) }];

		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');
		await importSnapshot(backup, pullPeerId('dev-self'), 'Self');

		expect(queryRows(`SELECT entity_id FROM sync_outbox WHERE action = 'DELETE'`)).toEqual([{ entity_id: 'gone' }]);
	});

	it('applies DELETE events', async () => {
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', remoteChain());
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [remote(4, 'customer', 'DELETE', 'c1', { id: 'c1' })]);

		expect(queryRows('SELECT id FROM customers')).toEqual([]);
		expect(queryRows('SELECT id FROM work_orders')).toEqual([]);
	});

	it('rolls back the whole batch and keeps the cursor when a delta is malformed', async () => {
		const batch = [remoteChain()[0], remote(2, 'customer', 'INSERT', 'c2', { id: 'c2' })];

		await expect(applyRemoteDeltas(pullPeerId('dev-b'), 'B', batch)).rejects.toBeInstanceOf(SyncProtocolError);
		expect(queryRows('SELECT id FROM customers')).toEqual([]);
		expect(await getPeerState(pullPeerId('dev-b'))).toBeNull();
	});

	it('rejects unknown entity types instead of silently dropping them', async () => {
		await expect(
			applyRemoteDeltas(pullPeerId('dev-b'), 'B', [remote(1, 'invoice', 'INSERT', 'x', {})])
		).rejects.toThrow('Unknown entity type');
	});

	it('pruning ignores pull cursors, which live in another seq space', async () => {
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e1', 'customer', 'c', 'INSERT', '{}', '2020-01-01T00:00:00.000Z')"
		);
		db.exec(
			"INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at) VALUES ('e2', 'customer', 'c', 'INSERT', '{}', '2020-01-02T00:00:00.000Z')"
		);
		await acknowledgeSync('relay:dropbox', 'Dropbox', 2);
		await acknowledgeSync(pullPeerId('dev-b'), 'B', 0);

		expect(await pruneStaleOutboxLogs(30, 30)).toBe(2);
	});
});

describe('component ledger sync', () => {
	const component = (id: string, updated_at: string, date: string) => ({
		id,
		bike_id: 'b1',
		component_type: 'chain',
		last_serviced_date: date,
		work_order_id: 'w1',
		notes: null,
		created_at: updated_at,
		updated_at
	});

	it('applies line item component tags and bike_component events, then deletes them', async () => {
		const chain = remoteChain();
		chain[2] = remote(3, 'work_order', 'INSERT', 'w1', {
			...JSON.parse(chain[2].payload),
			items: [
				{ id: 'i1', item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' }
			]
		});
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			...chain,
			remote(4, 'bike_component', 'INSERT', 'k1', component('k1', '2026-11-07T10:00:00.000Z', '2026-11-07'))
		]);

		expect(queryRows('SELECT component_type FROM work_order_items')).toEqual([{ component_type: 'chain' }]);
		expect(queryRows('SELECT component_type, last_serviced_date, work_order_id FROM bike_components')).toEqual([
			{ component_type: 'chain', last_serviced_date: '2026-11-07', work_order_id: 'w1' }
		]);
		expect(queryRows('SELECT id FROM sync_outbox')).toEqual([]);

		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [remote(5, 'bike_component', 'DELETE', 'k1', { id: 'k1' })]);
		expect(queryRows('SELECT id FROM bike_components')).toEqual([]);
	});

	it('keeps the service date and clears the link when the work order is gone', async () => {
		const result = await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			...remoteChain().slice(0, 2),
			remote(4, 'bike_component', 'INSERT', 'k1', component('k1', '2026-11-07T10:00:00.000Z', '2026-11-07'))
		]);

		expect(result).toMatchObject({ blocked: false, dropped: 0, lastSyncedSeq: 4 });
		expect(queryRows('SELECT last_serviced_date, work_order_id FROM bike_components')).toEqual([
			{ last_serviced_date: '2026-11-07', work_order_id: null }
		]);
	});

	it('keeps one row per (bike, component) when two devices created it with different ids; newest wins', async () => {
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', remoteChain());
		await applyRemoteDeltas(pullPeerId('dev-b'), 'B', [
			remote(4, 'bike_component', 'INSERT', 'k1', component('k1', '2026-11-07T10:00:00.000Z', '2026-11-07'))
		]);

		await applyRemoteDeltas(pullPeerId('dev-c'), 'C', [
			remote(1, 'bike_component', 'INSERT', 'k2', component('k2', '2026-11-08T10:00:00.000Z', '2026-11-08'))
		]);
		expect(queryRows('SELECT id, last_serviced_date FROM bike_components')).toEqual([
			{ id: 'k2', last_serviced_date: '2026-11-08' }
		]);

		await applyRemoteDeltas(pullPeerId('dev-d'), 'D', [
			remote(1, 'bike_component', 'INSERT', 'k3', component('k3', '2026-11-01T10:00:00.000Z', '2026-11-01'))
		]);
		expect(queryRows('SELECT id FROM bike_components')).toEqual([{ id: 'k2' }]);
	});

	it('round-trips the ledger and item tags through exportSnapshot/importSnapshot', async () => {
		const customer = await createCustomer({ name: 'Ana' });
		const bike = await createBike({ customer_id: customer.id, brand: 'Trek', model: 'Domane' });
		const order = await createWorkOrder({
			bike_id: bike.id,
			status: 'completed',
			issue_summary: 'Chain',
			items: [{ item_type: 'part', description: 'Chain', quantity: 1, unit_price_cents: 3500, component_type: 'chain' }]
		});

		const snapshot = await exportSnapshot();
		expect(snapshot.data.bike_components).toHaveLength(1);

		await importSnapshot(JSON.parse(JSON.stringify(snapshot)) as DatabaseSnapshot, 'self', 'Self');

		expect(queryRows('SELECT component_type FROM work_order_items')).toEqual([{ component_type: 'chain' }]);
		expect(queryRows('SELECT bike_id, component_type, work_order_id FROM bike_components')).toEqual([
			{ bike_id: bike.id, component_type: 'chain', work_order_id: order.id }
		]);
	});
});
