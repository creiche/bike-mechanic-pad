import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { INITIAL_SCHEMA } from './schema';

export interface SqliteConnection {
	exec(sql: string): void;
	close(): void;
}

type SqliteModule = {
	oo1: {
		OpfsDb?: new (filename: string, mode?: string) => {
			exec: (sql: string) => void;
			close: () => void;
		};
		DB?: new (filename: string, mode?: string) => {
			exec: (sql: string) => void;
			close: () => void;
		};
	};
};

const DB_FILENAME = '/bike-mechanic-pad.sqlite3';

let connectionPromise: Promise<SqliteConnection> | null = null;

export async function openDatabase(): Promise<SqliteConnection> {
	if (typeof window === 'undefined') {
		throw new Error('SQLite OPFS can only be initialized in the browser.');
	}

	if (!connectionPromise) {
		connectionPromise = (async () => {
			// sqlite-wasm initializes itself from the package's browser bundle. The Vite
			// configuration below is what enables the browser to load the WASM file safely
			// under the required COOP/COEP headers for OPFS persistence.
			const sqlite3 = (await sqlite3InitModule()) as SqliteModule;

			const DbCtor = sqlite3.oo1.OpfsDb ?? sqlite3.oo1.DB;
			if (!DbCtor) {
				throw new Error('SQLite WebAssembly module did not expose a usable database class.');
			}

			// OPFS (Origin Private File System) stores the database in a browser-private
			// sandboxed directory tied to the current origin. That means the app keeps its
			// customer, bike, and invoice data on the user's device instead of sending it to
			// a hosted API or remote database.
			const db = new DbCtor(DB_FILENAME, 'ct');

			// Foreign keys are required for the project relationships: customer -> bike -> work order.
			db.exec('PRAGMA foreign_keys = ON;');

            // Run schema initialization migration
            db.exec(INITIAL_SCHEMA);

			return {
				exec: (sql: string) => db.exec(sql),
				close: () => db.close()
			};
		})();
	}

	return connectionPromise;
}

export async function runQuery<T = void>(sql: string): Promise<T> {
	const connection = await openDatabase();
	connection.exec(sql);
	return undefined as T;
}

export async function closeDatabase(): Promise<void> {
	if (!connectionPromise) {
		return;
	}

	const connection = await connectionPromise;
	connection.close();
	connectionPromise = null;
}
