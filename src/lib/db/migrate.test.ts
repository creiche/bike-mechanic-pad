import { beforeEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate, type MigratableDb } from './migrate';
import { MIGRATIONS, type Migration } from './schema';

const sqlite3 = await sqlite3InitModule();
let db: MigratableDb;

const query = (sql: string) =>
	db.exec({ sql, rowMode: 'array', returnValue: 'resultRows' }) as unknown[][];
const version = () => query('PRAGMA user_version')[0][0];

// A tiny pretend history: v1 creates a table, v2 adds a column to it.
const V1: Migration = {
	version: 1,
	name: 'v1 bikes',
	sql: 'CREATE TABLE bikes (id TEXT PRIMARY KEY, brand TEXT NOT NULL);'
};
const V2: Migration = {
	version: 2,
	name: 'v2 bikes status',
	sql: "ALTER TABLE bikes ADD COLUMN status TEXT NOT NULL DEFAULT 'new';"
};

beforeEach(() => {
	db = new sqlite3.oo1.DB(':memory:') as unknown as MigratableDb;
});

describe('migrate', () => {
	it('builds a new database up to the latest version', () => {
		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
		expect(query("SELECT name FROM sqlite_master WHERE name = 'customers'")).toHaveLength(1);
	});

	it('is safe to run twice', () => {
		migrate(db);
		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
	});

	it('upgrades an existing database and keeps its data', () => {
		migrate(db, [V1]);
		db.exec({ sql: "INSERT INTO bikes (id, brand) VALUES ('b1', 'Trek')" });

		migrate(db, [V1, V2]);

		expect(version()).toBe(2);
		expect(query('SELECT brand, status FROM bikes')).toEqual([['Trek', 'new']]);
	});

	it('adopts a database that predates versioning (tables exist, version 0)', () => {
		// Early installs ran the schema without ever setting user_version.
		db.exec({ sql: MIGRATIONS[0].sql });
		db.exec({ sql: "INSERT INTO customers (id, name) VALUES ('c1', 'Ana')" });
		expect(version()).toBe(0);

		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
		expect(query('SELECT name FROM customers')).toEqual([['Ana']]);
	});

	it('creates work order tables when upgrading from v1 to v3', () => {
		migrate(db, [MIGRATIONS[0]]);
		db.exec({ sql: "INSERT INTO customers (id, name) VALUES ('c1', 'Ana')" });
		db.exec({ sql: "INSERT INTO bikes (id, customer_id, brand, model) VALUES ('b1', 'c1', 'Trek', 'Domane')" });

		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
		expect(query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_orders'"))
			.toEqual([['work_orders']]);
		expect(query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_order_items'"))
			.toEqual([['work_order_items']]);
		expect(query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'"))
			.toEqual([['sync_outbox']]);
		expect(query('SELECT id FROM bikes')).toEqual([['b1']]);
	});

	it('preserves v3 outbox rows when migrating to v4 append-only log', () => {
		migrate(db, MIGRATIONS.slice(0, 3));

		db.exec({
			sql: `INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at)
			      VALUES ('b-id', 'work_order', 'wo-2', 'INSERT', '{"v":2}', '2026-01-01T00:00:00.000Z')`
		});
		db.exec({
			sql: `INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at)
			      VALUES ('a-id', 'work_order', 'wo-1', 'INSERT', '{"v":1}', '2026-01-01T00:00:00.000Z')`
		});

		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
		expect(
			query('SELECT seq, id, entity_id FROM sync_outbox ORDER BY seq ASC')
		).toEqual([
			[1, 'a-id', 'wo-1'],
			[2, 'b-id', 'wo-2']
		]);
	});

	it('creates peer_sync_state table in v4', () => {
		migrate(db);

		expect(query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_sync_state'"))
			.toEqual([['peer_sync_state']]);
	});

	it('rolls back a failing migration and stays on the previous version', () => {
		const broken: Migration = {
			version: 2,
			name: 'broken migration',
			sql: 'ALTER TABLE bikes ADD COLUMN ok TEXT; ALTER TABLE nope ADD COLUMN x TEXT;'
		};
		migrate(db, [V1]);

		expect(() => migrate(db, [V1, broken])).toThrow('Migration 2 failed');

		expect(version()).toBe(1);
		// The first statement of the broken migration must have been undone too.
		expect(query("SELECT name FROM pragma_table_info('bikes')").flat()).toEqual(['id', 'brand']);
	});

	it('applies several pending migrations all-or-nothing', () => {
		const broken: Migration = {
			version: 3,
			name: 'broken migration',
			sql: 'ALTER TABLE nope ADD COLUMN x TEXT;'
		};
		migrate(db, [V1]);

		expect(() => migrate(db, [V1, V2, broken])).toThrow('Migration 3 failed');

		expect(version()).toBe(1);
		expect(query("SELECT name FROM pragma_table_info('bikes')").flat()).toEqual(['id', 'brand']);
	});

	it('refuses a database that is newer than the app', () => {
		migrate(db, [V1, V2]);

		expect(() => migrate(db, [V1])).toThrow('newer than this app supports');
	});

	it('rejects non-sequential migration version numbers', () => {
		const invalid: Migration[] = [
			{ version: 1, name: 'one', sql: 'CREATE TABLE one (id TEXT PRIMARY KEY);' },
			{ version: 3, name: 'three', sql: 'CREATE TABLE three (id TEXT PRIMARY KEY);' }
		];

		expect(() => migrate(db, invalid)).toThrow('Invalid migration order');
	});
});
