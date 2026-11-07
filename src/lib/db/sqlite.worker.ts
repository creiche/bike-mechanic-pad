import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from './migrate';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

// Dedicated worker that owns the SQLite database. OPFS storage only works off the main thread.

const DB_FILENAME = '/bike-mechanic-pad.sqlite3';

// Minimal view of the database. The library's `exec` is typed with many overloads that cannot be
// satisfied by options arriving over postMessage, so we describe only what we use.
interface WorkerDatabase {
	exec(options: Record<string, unknown>): unknown;
	close(): void;
}

let db: WorkerDatabase | null = null;

async function openDatabase(): Promise<void> {
	// Keep the library's warnings: when OPFS fails to install, the real reason is only logged there.
	const warnings: string[] = [];
	(globalThis as Record<string, unknown>).sqlite3ApiConfig = {
		warn: (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
			console.warn(...args);
		}
	};

	const sqlite3 = await sqlite3InitModule();

	// sqlite-wasm deletes `sqlite3.opfs` after bootstrap, so `'opfs' in sqlite3` is always false.
	// `OpfsDb` only exists when the OPFS VFS installed successfully.
	if (!sqlite3.oo1.OpfsDb) {
		throw new Error(
			`OPFS is unavailable (crossOriginIsolated=${self.crossOriginIsolated}, ` +
				`SharedArrayBuffer=${typeof SharedArrayBuffer}). ${warnings.join(' | ')}`
		);
	}

	db = new sqlite3.oo1.OpfsDb(DB_FILENAME) as unknown as WorkerDatabase;
	db.exec({ sql: 'PRAGMA foreign_keys = ON;' });
	migrate(db);
}

async function handle(request: WorkerRequest): Promise<unknown> {
	if (request.type === 'init') {
		return openDatabase();
	}

	if (!db) {
		throw new Error('SQLite worker is not initialized.');
	}

	if (request.type === 'exec') {
		const { returnValue } = request.options ?? {};
		const result = db.exec({ sql: request.sql, ...request.options });
		// Without returnValue, exec() returns the db object itself, which must not cross postMessage.
		return returnValue === 'resultRows' ? result : undefined;
	}

	db.close();
	db = null;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const { id } = event.data;
	try {
		const result = await handle(event.data);
		self.postMessage({ id, ok: true, result } satisfies WorkerResponse);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		self.postMessage({ id, ok: false, error: message } satisfies WorkerResponse);
	}
};
