import { openDatabase, type SqliteConnection } from './client';

// Run `work` inside one atomic BEGIN IMMEDIATE transaction; any throw rolls everything back.
export async function inTransaction<T>(work: (connection: SqliteConnection) => Promise<T>): Promise<T> {
	const connection = await openDatabase();
	await connection.exec('BEGIN IMMEDIATE');
	try {
		const result = await work(connection);
		await connection.exec('COMMIT');
		return result;
	} catch (error) {
		try {
			await connection.exec('ROLLBACK');
		} catch {
			/* already rolled back */
		}
		throw error;
	}
}
