import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import type { DbExecOptions, WorkerRequest, WorkerResponse } from './worker-protocol';

export type { DbExecOptions };

export interface SqliteConnection {
	exec(sql: string, options?: DbExecOptions): Promise<unknown>;
	close(): Promise<void>;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

let connectionPromise: Promise<SqliteConnection> | null = null;

async function connect(): Promise<SqliteConnection> {
	// By default the browser may evict OPFS data under disk pressure (Safari also after ~7 days unused).
	// Ask for persistent storage so the shop's only copy of its data is not silently deleted.
	// Not awaited: the browser may show a permission prompt and we must not block startup on it.
	void navigator.storage?.persist?.().then((granted) => {
		if (!granted) {
			console.warn('Persistent storage was not granted; the browser may evict local data.');
		}
	});

	const worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' });
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let nextId = 1;

	// Send one request to the worker and wait for the reply carrying the same id.
	const send = (request: DistributiveOmit<WorkerRequest, 'id'>) =>
		new Promise<unknown>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			worker.postMessage({ ...request, id } as WorkerRequest);
		});

	worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
		const reply = event.data;
		const request = pending.get(reply.id);
		pending.delete(reply.id);
		if (reply.ok) {
			request?.resolve(reply.result);
		} else {
			request?.reject(new Error(reply.error));
		}
	};

	// A crash in the worker (e.g. failed module load) would otherwise leave every request waiting forever.
	// Also drop the cached connection so the next call starts a fresh worker instead of talking to a dead one.
	worker.onerror = (event) => {
		for (const request of pending.values()) {
			request.reject(new Error(event.message || 'SQLite worker error.'));
		}
		pending.clear();
		worker.terminate();
		connectionPromise = null;
	};

	try {
		await send({ type: 'init' });
	} catch (error) {
		worker.terminate();
		throw error;
	}

	return {
		exec: (sql, options) => send({ type: 'exec', sql, options }),
		async close() {
			await send({ type: 'close' });
			worker.terminate();
		}
	};
}

export function openDatabase(): Promise<SqliteConnection> {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('SQLite OPFS can only be initialized in the browser.'));
	}

	if (!connectionPromise) {
		connectionPromise = connect().catch((error: unknown) => {
			connectionPromise = null; // let the next call retry instead of caching the failure
			throw error;
		});
	}

	return connectionPromise;
}

export async function runQuery<T = void>(sql: string, bind: BindingSpec = []): Promise<T> {
	const connection = await openDatabase();
	return (await connection.exec(sql, { bind })) as T;
}

export async function closeDatabase(): Promise<void> {
	if (!connectionPromise) {
		return;
	}

	const connection = await connectionPromise;
	connectionPromise = null;
	await connection.close();
}

// Run a SELECT and return rows as objects; shared by every repository.
export async function selectRows<T>(sql: string, bind: BindingSpec = []): Promise<T[]> {
	const connection = await openDatabase();
	const result = await connection.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' });
	return Array.isArray(result) ? (result as T[]) : [];
}
