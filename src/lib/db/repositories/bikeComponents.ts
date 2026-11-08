import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { isComponentType, isServiceDate, type ComponentType } from '../../domain/componentTypes';
import { openDatabase, type SqliteConnection } from '../client';
import { notifyLocalWrite } from '../localWrites';
import { inTransaction } from '../transaction';
import { appendMutation } from './sync';

// One row per (bike, component type): when that part was last replaced or serviced, and by which work order.
export interface BikeComponent {
	id: string;
	bike_id: string;
	component_type: ComponentType;
	last_serviced_date: string;
	work_order_id: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface LogComponentServiceInput {
	bike_id: string;
	component_type: string;
	last_serviced_date: string;
	work_order_id?: string | null;
	notes?: string | null;
}

async function selectRows<T>(sql: string, bind: BindingSpec = []): Promise<T[]> {
	const connection = await openDatabase();
	const result = await connection.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' });
	return Array.isArray(result) ? (result as T[]) : [];
}

export function getBikeComponents(bikeId: string): Promise<BikeComponent[]> {
	return selectRows<BikeComponent>('SELECT * FROM bike_components WHERE bike_id = ? ORDER BY component_type ASC', [
		bikeId
	]);
}

// Insert or update the ledger row for (bike, component type) and queue it for sync.
// MUST run inside a transaction: the work order completion path calls it in the same one as the status change.
export async function upsertBikeComponent(
	connection: SqliteConnection,
	input: LogComponentServiceInput
): Promise<BikeComponent> {
	if (!isComponentType(input.component_type)) {
		throw new Error(`Unknown component type: ${input.component_type}`);
	}
	if (!isServiceDate(input.last_serviced_date)) {
		throw new Error('Service date must be a valid YYYY-MM-DD date.');
	}

	const [existing] = await selectRows<BikeComponent>(
		'SELECT * FROM bike_components WHERE bike_id = ? AND component_type = ?',
		[input.bike_id, input.component_type]
	);
	const now = new Date().toISOString();
	const row: BikeComponent = {
		id: existing?.id ?? crypto.randomUUID(),
		bike_id: input.bike_id,
		component_type: input.component_type,
		last_serviced_date: input.last_serviced_date,
		work_order_id: input.work_order_id ?? null,
		notes: input.notes === undefined ? (existing?.notes ?? null) : input.notes,
		created_at: existing?.created_at ?? now,
		updated_at: now
	};

	if (existing) {
		await connection.exec(
			`UPDATE bike_components
			 SET last_serviced_date = ?, work_order_id = ?, notes = ?, updated_at = ?
			 WHERE id = ?`,
			{ bind: [row.last_serviced_date, row.work_order_id, row.notes, row.updated_at, row.id] }
		);
	} else {
		await connection.exec(
			`INSERT INTO bike_components
			   (id, bike_id, component_type, last_serviced_date, work_order_id, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			{
				bind: [
					row.id,
					row.bike_id,
					row.component_type,
					row.last_serviced_date,
					row.work_order_id,
					row.notes,
					row.created_at,
					row.updated_at
				]
			}
		);
	}

	await appendMutation({
		entity_type: 'bike_component',
		entity_id: row.id,
		action: existing ? 'UPDATE' : 'INSERT',
		payload: { ...row }
	});

	return row;
}

// Manual ledger entry, e.g. a part the mechanic replaced before the bike had any work orders here.
export async function logComponentService(input: LogComponentServiceInput): Promise<BikeComponent> {
	const row = await inTransaction((connection) => upsertBikeComponent(connection, input));
	notifyLocalWrite();
	return row;
}

export async function deleteBikeComponent(componentId: string): Promise<void> {
	await inTransaction(async (connection) => {
		await connection.exec('DELETE FROM bike_components WHERE id = ?', { bind: [componentId] });
		await appendMutation({
			entity_type: 'bike_component',
			entity_id: componentId,
			action: 'DELETE',
			payload: { id: componentId }
		});
	});
	notifyLocalWrite();
}
