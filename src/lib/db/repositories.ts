import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { openDatabase, runQuery } from './client';

export interface Customer {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
	notes: string | null;
	created_at: string;
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

async function selectRows<T>(sql: string, bind: BindingSpec = []): Promise<T[]> {
	const connection = await openDatabase();
	const result = await connection.exec(sql, {
		bind,
		rowMode: 'object',
		returnValue: 'resultRows'
	});

	return Array.isArray(result) ? (result as T[]) : [];
}

export async function getCustomers(): Promise<Customer[]> {
	return selectRows<Customer>(
		`SELECT * FROM customers ORDER BY created_at DESC, name ASC`
	);
}

export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
	const customerId = input.id ?? crypto.randomUUID();
	const name = input.name.trim();

	if (!name) {
		throw new Error('Customer name is required.');
	}

	await runQuery(
		`INSERT INTO customers (id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?)`,
		[customerId, name, input.phone ?? null, input.email ?? null, input.notes ?? null]
	);

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

export async function createBike(input: CreateBikeInput): Promise<Bike> {
	const bikeId = input.id ?? crypto.randomUUID();
	const brand = input.brand.trim();
	const model = input.model.trim();

	if (!brand || !model) {
		throw new Error('Bike brand and model are required.');
	}

	await runQuery(
		`INSERT INTO bikes (id, customer_id, brand, model, year, color, serial_number, notes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			bikeId,
			input.customer_id,
			brand,
			model,
			input.year ?? null,
			input.color ?? null,
			input.serial_number ?? null,
			input.notes ?? null
		]
	);

	const [bike] = await selectRows<Bike>('SELECT * FROM bikes WHERE id = ?', [bikeId]);
	if (!bike) {
		throw new Error('Bike record could not be loaded after insert.');
	}

	return bike;
}

export async function deleteCustomer(customerId: string): Promise<void> {
	await runQuery('DELETE FROM customers WHERE id = ?', [customerId]);
}
