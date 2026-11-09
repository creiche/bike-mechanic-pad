import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { openDatabase, selectRows } from './client';
import { notifyLocalWrite } from './localWrites';
import { appendMutation } from './repositories/sync';
import { inTransaction } from './transaction';

export interface Customer {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
	notes: string | null;
	created_at: string;
	// Last-write-wins key for sync: the newest updated_at survives on every device.
	updated_at: string;
}

export interface Bike {
	id: string;
	customer_id: string;
	brand: string;
	model: string;
	year: number | null;
	color: string | null;
	serial_number: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateCustomerInput {
	id?: string;
	name: string;
	phone?: string | null;
	email?: string | null;
	notes?: string | null;
}

export interface CreateBikeInput {
	id?: string;
	customer_id: string;
	brand: string;
	model: string;
	year?: number | null;
	color?: string | null;
	serial_number?: string | null;
	notes?: string | null;
}

export type UpdateCustomerInput = Omit<CreateCustomerInput, 'id'>;
export type UpdateBikeInput = Omit<CreateBikeInput, 'id' | 'customer_id'>;

export async function getCustomers(): Promise<Customer[]> {
	return selectRows<Customer>(
		`SELECT * FROM customers ORDER BY created_at DESC, name ASC`
	);
}

export async function getCustomer(customerId: string): Promise<Customer | null> {
	const [customer] = await selectRows<Customer>('SELECT * FROM customers WHERE id = ?', [customerId]);
	return customer ?? null;
}

// Replaces name/phone/email/notes; the outbox payload carries the whole row so peers can upsert it.
export async function updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
	const name = input.name.trim();
	if (!name) {
		throw new Error('Customer name is required.');
	}

	const fields = {
		name,
		phone: input.phone ?? null,
		email: input.email ?? null,
		notes: input.notes ?? null
	};

	await inTransaction(async (connection) => {
		const [existing] = await selectRows<{ created_at: string }>('SELECT created_at FROM customers WHERE id = ?', [
			customerId
		]);
		if (!existing) {
			throw new Error('Customer not found.');
		}

		const updatedAt = new Date().toISOString();
		await connection.exec(`UPDATE customers SET name = ?, phone = ?, email = ?, notes = ?, updated_at = ? WHERE id = ?`, {
			bind: [fields.name, fields.phone, fields.email, fields.notes, updatedAt, customerId]
		});
		await appendMutation({
			entity_type: 'customer',
			entity_id: customerId,
			action: 'UPDATE',
			payload: { id: customerId, ...fields, created_at: existing.created_at, updated_at: updatedAt }
		});
	});
	notifyLocalWrite();

	const customer = await getCustomer(customerId);
	if (!customer) {
		throw new Error('Customer record could not be loaded after update.');
	}
	return customer;
}

export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
	const customerId = input.id ?? crypto.randomUUID();
	const name = input.name.trim();

	if (!name) {
		throw new Error('Customer name is required.');
	}

	const now = new Date().toISOString();
	await inTransaction(async (connection) => {
		await connection.exec(
			`INSERT INTO customers (id, name, phone, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			{ bind: [customerId, name, input.phone ?? null, input.email ?? null, input.notes ?? null, now, now] }
		);
		await appendMutation({
			entity_type: 'customer',
			entity_id: customerId,
			action: 'INSERT',
			payload: {
				id: customerId,
				name,
				phone: input.phone ?? null,
				email: input.email ?? null,
				notes: input.notes ?? null,
				created_at: now,
				updated_at: now
			}
		});
	});
	notifyLocalWrite();

	const [customer] = await selectRows<Customer>('SELECT * FROM customers WHERE id = ?', [customerId]);
	if (!customer) {
		throw new Error('Customer record could not be loaded after insert.');
	}

	return customer;
}

export async function getBikesForCustomer(customerId: string): Promise<Bike[]> {
	return selectRows<Bike>(
		`SELECT * FROM bikes WHERE customer_id = ? ORDER BY created_at DESC, brand ASC, model ASC`,
		[customerId]
	);
}

export async function getBike(bikeId: string): Promise<Bike | null> {
	const [bike] = await selectRows<Bike>('SELECT * FROM bikes WHERE id = ?', [bikeId]);
	return bike ?? null;
}

export async function updateBike(bikeId: string, input: UpdateBikeInput): Promise<Bike> {
	const brand = input.brand.trim();
	const model = input.model.trim();
	if (!brand || !model) {
		throw new Error('Bike brand and model are required.');
	}

	await inTransaction(async (connection) => {
		const [row] = await selectRows<{ customer_id: string; created_at: string }>(
			'SELECT customer_id, created_at FROM bikes WHERE id = ?',
			[bikeId]
		);
		if (!row) {
			throw new Error('Bike not found.');
		}

		const fields = {
			brand,
			model,
			year: input.year ?? null,
			color: input.color ?? null,
			serial_number: input.serial_number ?? null,
			notes: input.notes ?? null
		};

		const updatedAt = new Date().toISOString();
		await connection.exec(
			`UPDATE bikes SET brand = ?, model = ?, year = ?, color = ?, serial_number = ?, notes = ?, updated_at = ? WHERE id = ?`,
			{ bind: [...Object.values(fields), updatedAt, bikeId] }
		);
		await appendMutation({
			entity_type: 'bike',
			entity_id: bikeId,
			action: 'UPDATE',
			payload: { id: bikeId, customer_id: row.customer_id, ...fields, created_at: row.created_at, updated_at: updatedAt }
		});
	});
	notifyLocalWrite();

	const bike = await getBike(bikeId);
	if (!bike) {
		throw new Error('Bike record could not be loaded after update.');
	}
	return bike;
}

// Cascades to the bike's work orders and component ledger.
export async function deleteBike(bikeId: string): Promise<void> {
	await inTransaction(async (connection) => {
		await connection.exec('DELETE FROM bikes WHERE id = ?', { bind: [bikeId] });
		await appendMutation({
			entity_type: 'bike',
			entity_id: bikeId,
			action: 'DELETE',
			payload: { id: bikeId }
		});
	});
	notifyLocalWrite();
}

export async function createBike(input: CreateBikeInput): Promise<Bike> {
	const bikeId = input.id ?? crypto.randomUUID();
	const brand = input.brand.trim();
	const model = input.model.trim();

	if (!brand || !model) {
		throw new Error('Bike brand and model are required.');
	}

	const now = new Date().toISOString();
	const bikeFields = {
		id: bikeId,
		customer_id: input.customer_id,
		brand,
		model,
		year: input.year ?? null,
		color: input.color ?? null,
		serial_number: input.serial_number ?? null,
		notes: input.notes ?? null,
		created_at: now,
		updated_at: now
	};

	await inTransaction(async (connection) => {
		await connection.exec(
			`INSERT INTO bikes (id, customer_id, brand, model, year, color, serial_number, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			{ bind: Object.values(bikeFields) }
		);
		await appendMutation({ entity_type: 'bike', entity_id: bikeId, action: 'INSERT', payload: bikeFields });
	});
	notifyLocalWrite();

	const [bike] = await selectRows<Bike>('SELECT * FROM bikes WHERE id = ?', [bikeId]);
	if (!bike) {
		throw new Error('Bike record could not be loaded after insert.');
	}

	return bike;
}

export async function deleteCustomer(customerId: string): Promise<void> {
	await inTransaction(async (connection) => {
		await connection.exec('DELETE FROM customers WHERE id = ?', { bind: [customerId] });
		await appendMutation({
			entity_type: 'customer',
			entity_id: customerId,
			action: 'DELETE',
			payload: { id: customerId }
		});
	});
	notifyLocalWrite();
}
