import { beforeEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate, type MigratableDb } from './migrate';
import { MIGRATIONS } from './schema';

const sqlite3 = await sqlite3InitModule();
let db: MigratableDb;

const query = (sql: string) =>
	db.exec({ sql, rowMode: 'array', returnValue: 'resultRows' }) as unknown[][];
const version = () => query('PRAGMA user_version')[0][0];

// A tiny pretend history: v1 creates a table, v2 adds a column to it.
const V1 = 'CREATE TABLE bikes (id TEXT PRIMARY KEY, brand TEXT NOT NULL);';
const V2 = "ALTER TABLE bikes ADD COLUMN status TEXT NOT NULL DEFAULT 'new';";

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
		db.exec({ sql: MIGRATIONS[0] });
		db.exec({ sql: "INSERT INTO customers (id, name) VALUES ('c1', 'Ana')" });
		expect(version()).toBe(0);

		migrate(db);

		expect(version()).toBe(MIGRATIONS.length);
		expect(query('SELECT name FROM customers')).toEqual([['Ana']]);
	});

	it('rolls back a failing migration and stays on the previous version', () => {
		const broken = 'ALTER TABLE bikes ADD COLUMN ok TEXT; ALTER TABLE nope ADD COLUMN x TEXT;';
		migrate(db, [V1]);

		expect(() => migrate(db, [V1, broken])).toThrow('Migration 2 failed');

		expect(version()).toBe(1);
		// The first statement of the broken migration must have been undone too.
		expect(query("SELECT name FROM pragma_table_info('bikes')").flat()).toEqual(['id', 'brand']);
	});

	it('applies several pending migrations all-or-nothing', () => {
		migrate(db, [V1]);

		expect(() => migrate(db, [V1, V2, 'ALTER TABLE nope ADD COLUMN x TEXT;'])).toThrow('Migration 3 failed');

		expect(version()).toBe(1);
		expect(query("SELECT name FROM pragma_table_info('bikes')").flat()).toEqual(['id', 'brand']);
	});

	it('refuses a database that is newer than the app', () => {
		migrate(db, [V1, V2]);

		expect(() => migrate(db, [V1])).toThrow('newer than this app supports');
	});
});
