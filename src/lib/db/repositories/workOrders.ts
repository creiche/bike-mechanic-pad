import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { openDatabase } from '../client';
import { notifyLocalWrite } from '../localWrites';

const WORK_ORDER_STATUSES = ['open', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled'] as const;
const WORK_ORDER_ITEM_TYPES = ['labor', 'part'] as const;

type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
type WorkOrderItemType = (typeof WORK_ORDER_ITEM_TYPES)[number];

export interface WorkOrderItem {
	id: string;
	work_order_id: string;
	item_type: WorkOrderItemType;
	description: string;
	quantity: number;
	unit_price_cents: number;
	created_at: string;
}

export interface WorkOrder {
	id: string;
	bike_id: string;
	status: WorkOrderStatus;
	issue_summary: string;
	notes: string | null;
	total_cents: number;
	created_at: string;
	updated_at: string;
	items: WorkOrderItem[];
}

export interface CreateWorkOrderItemInput {
	id?: string;
	item_type: WorkOrderItemType;
	description: string;
	quantity: number;
	unit_price_cents: number;
}

export interface CreateWorkOrderInput {
	id?: string;
	bike_id: string;
	status?: WorkOrderStatus;
	issue_summary: string;
	notes?: string | null;
	items: CreateWorkOrderItemInput[];
}

interface WorkOrderRow {
	id: string;
	bike_id: string;
	status: WorkOrderStatus;
	issue_summary: string;
	notes: string | null;
	total_cents: number;
	created_at: string;
	updated_at: string;
}

function assertSafeInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} must be a safe integer.`);
	}
}

function assertWorkOrderStatus(status: string): asserts status is WorkOrderStatus {
	if (!WORK_ORDER_STATUSES.includes(status as WorkOrderStatus)) {
		throw new Error(`Invalid work order status: ${status}`);
	}
}

function assertWorkOrderItemType(itemType: string): asserts itemType is WorkOrderItemType {
	if (!WORK_ORDER_ITEM_TYPES.includes(itemType as WorkOrderItemType)) {
		throw new Error(`Invalid work order item type: ${itemType}`);
	}
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

function prepareItems(items: CreateWorkOrderItemInput[]): Array<CreateWorkOrderItemInput & { id: string }> {
	return items.map((item) => {
		assertWorkOrderItemType(item.item_type);
		const description = item.description.trim();
		if (!description) {
			throw new Error('Work order item description is required.');
		}

		assertSafeInteger('Work order item quantity', item.quantity);
		assertSafeInteger('Work order item unit_price_cents', item.unit_price_cents);
		if (item.quantity <= 0) {
			throw new Error('Work order item quantity must be greater than zero.');
		}
		if (item.unit_price_cents < 0) {
			throw new Error('Work order item unit_price_cents must be zero or greater.');
		}

		return {
			...item,
			description,
			id: item.id ?? crypto.randomUUID()
		};
	});
}

export async function createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
	const workOrderId = input.id ?? crypto.randomUUID();
	const status = input.status ?? 'open';
	assertWorkOrderStatus(status);

	const issueSummary = input.issue_summary.trim();
	if (!issueSummary) {
		throw new Error('Work order issue summary is required.');
	}

	const notes = input.notes ?? null;
	const items = prepareItems(input.items);
	let totalCents = 0;
	for (const item of items) {
		const lineTotalCents = item.quantity * item.unit_price_cents;
		assertSafeInteger('Work order item total_cents', lineTotalCents);
		totalCents += lineTotalCents;
		assertSafeInteger('Work order total_cents', totalCents);
	}

	const payload = {
		id: workOrderId,
		bike_id: input.bike_id,
		status,
		issue_summary: issueSummary,
		notes,
		total_cents: totalCents,
		items: items.map((item) => ({
			id: item.id,
			item_type: item.item_type,
			description: item.description,
			quantity: item.quantity,
			unit_price_cents: item.unit_price_cents
		}))
	};

	const connection = await openDatabase();
	await connection.exec('BEGIN IMMEDIATE');
	try {
		await connection.exec(
			`INSERT INTO work_orders (id, bike_id, status, issue_summary, notes, total_cents)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			{
				bind: [workOrderId, input.bike_id, status, issueSummary, notes, totalCents]
			}
		);

		for (const item of items) {
			await connection.exec(
				`INSERT INTO work_order_items (id, work_order_id, item_type, description, quantity, unit_price_cents)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				{
					bind: [
						item.id,
						workOrderId,
						item.item_type,
						item.description,
						item.quantity,
						item.unit_price_cents
					]
				}
			);
		}

		await connection.exec(
			`INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload)
			 VALUES (?, ?, ?, ?, ?)`,
			{
				bind: [crypto.randomUUID(), 'work_order', workOrderId, 'INSERT', JSON.stringify(payload)]
			}
		);

		await connection.exec('COMMIT');
	} catch (error) {
		try {
			await connection.exec('ROLLBACK');
		} catch {
			/* already rolled back */
		}
		throw error;
	}
	notifyLocalWrite();

	const [workOrder] = await selectRows<WorkOrderRow>('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);
	if (!workOrder) {
		throw new Error('Work order record could not be loaded after insert.');
	}

	const workOrderItems = await selectRows<WorkOrderItem>(
		`SELECT id, work_order_id, item_type, description, quantity, unit_price_cents, created_at
		 FROM work_order_items
		 WHERE work_order_id = ?
		 ORDER BY created_at ASC`,
		[workOrderId]
	);

	return {
		...workOrder,
		items: workOrderItems
	};
}
