import { openDatabase, type SqliteConnection } from './client';

// The connection is shared, so transactions must not overlap: each one waits for the previous to finish.
let queue: Promise<unknown> = Promise.resolve();
// Run `work` inside one atomic BEGIN IMMEDIATE transaction; any throw rolls everything back.
// Do not call inTransaction from inside `work` (it would wait on itself forever).
export function inTransaction<T>(work: (connection: SqliteConnection) => Promise<T>): Promise<T> {
	const run = queue.then(() => runTransaction(work));
	queue = run.catch(() => undefined);
	return run;
}

async function runTransaction<T>(work: (connection: SqliteConnection) => Promise<T>): Promise<T> {
	const connection = await openDatabase();
	await connection.exec('BEGIN IMMEDIATE');
	try {
		const result = await work(connection);
		await connection.exec('COMMIT');
		return result;
	} catch (error) {
		try {
			await connection.exec('ROLLBACK'); // rejects at once if the worker died (see client.ts)
		} catch {
			/* already rolled back */
		}
		throw error;
	}
}
