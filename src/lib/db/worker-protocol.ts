import type { BindingSpec } from '@sqlite.org/sqlite-wasm';

// Messages shared by the main-thread client (client.ts) and the SQLite worker (sqlite.worker.ts).
// Every request carries an id; the worker echoes it back so the client can match replies.

export type DbExecOptions = {
	bind?: BindingSpec;
	rowMode?: 'array' | 'object';
	returnValue?: 'resultRows';
};

export type WorkerRequest =
	| { id: number; type: 'init' }
	| { id: number; type: 'exec'; sql: string; options?: DbExecOptions }
	| { id: number; type: 'close' };

export type WorkerResponse =
	| { id: number; ok: true; result?: unknown }
	| { id: number; ok: false; error: string };
