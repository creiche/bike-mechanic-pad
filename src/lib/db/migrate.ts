import { MIGRATIONS, type Migration } from './schema';

// Minimal view of the database, shared by the OPFS worker and the tests.
export interface MigratableDb {
	exec(options: Record<string, unknown>): unknown;
}

// Bring the database up to the latest schema version. Safe to run on every start.
// The version number lives inside the database file (PRAGMA user_version, 0 for a brand-new file),
// so it always travels with the user's data.
export function migrate(db: MigratableDb, migrations: Migration[] = MIGRATIONS): void {
	// One transaction for the whole run. IMMEDIATE takes the write lock BEFORE the version is read, so a
	// second tab starting at the same time waits, then sees the new version and has nothing left to do.
	// A failure rolls everything back, and the version only moves when all the SQL succeeded.
	db.exec({ sql: 'BEGIN IMMEDIATE' });
	let step = 'Version check';
	try {
		const rows = db.exec({ sql: 'PRAGMA user_version', rowMode: 'array', returnValue: 'resultRows' }) as number[][];
		const current = rows[0][0];

		// A stale cached copy of the app must not touch a database that a newer version already upgraded.
		if (current > migrations.length) {
			throw new Error(
				`Database schema version ${current} is newer than this app supports (${migrations.length}). Reload to get the latest version.`
			);
		}

		for (let index = 0; index < migrations.length; index++) {
			const expected = index + 1;
			if (migrations[index].version !== expected) {
				throw new Error(
					`Invalid migration order: expected version ${expected} at index ${index}, got ${migrations[index].version}.`
				);
			}
		}

		for (let version = current + 1; version <= migrations.length; version++) {
			step = `Migration ${version}`;
			db.exec({ sql: migrations[version - 1].sql });
		}
		if (current < migrations.length) {
			db.exec({ sql: `PRAGMA user_version = ${migrations.length}` }); // PRAGMA cannot take bound parameters
		}
		step = 'Commit';
		db.exec({ sql: 'COMMIT' });
	} catch (error) {
		// If COMMIT itself failed, SQLite has already rolled back and ROLLBACK would throw
		// "no transaction is active", hiding the real cause. So ignore a failing ROLLBACK.
		try {
			db.exec({ sql: 'ROLLBACK' });
		} catch {
			/* already rolled back */
		}
		const message = error instanceof Error ? error.message : String(error);
		throw step === 'Version check' ? error : new Error(`${step} failed: ${message}`);
	}
}
