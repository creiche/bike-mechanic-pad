import { isComponentType, todayLocalDate, type ComponentType } from '../../domain/componentTypes';
import { lineTotalCents, sumLineTotals } from '../../domain/money';
import { openDatabase, selectRows, type SqliteConnection } from '../client';
import { notifyLocalWrite } from '../localWrites';
import { inTransaction } from '../transaction';
import { upsertBikeComponent } from './bikeComponents';
import { appendMutation } from './sync';

export const WORK_ORDER_STATUSES = ['open', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled'] as const;
export const WORK_ORDER_ITEM_TYPES = ['labor', 'part'] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
export type WorkOrderItemType = (typeof WORK_ORDER_ITEM_TYPES)[number];

// Finished orders are an invoice record: line items are frozen until the order is reopened.
const LOCKED_STATUSES: readonly WorkOrderStatus[] = ['completed', 'cancelled'];

export interface WorkOrderItem {
	id: string;
	work_order_id: string;
	item_type: WorkOrderItemType;
	description: string;
	quantity: number;
	unit_price_cents: number;
	// Completing the work order stamps this component's ledger entry on the bike.
	component_type: ComponentType | null;
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

// A work order plus the joined customer/bike labels the dashboard needs.
export interface WorkOrderSummary extends Omit<WorkOrder, 'items'> {
	customer_id: string;
	customer_name: string;
	bike_brand: string;
	bike_model: string;
	item_count: number;
}

export interface CreateWorkOrderItemInput {
	id?: string;
	item_type: WorkOrderItemType;
	description: string;
	quantity: number;
	unit_price_cents: number;
	component_type?: ComponentType | null;
}

export interface CreateWorkOrderInput {
	id?: string;
	bike_id: string;
	status?: WorkOrderStatus;
	issue_summary: string;
	notes?: string | null;
	items: CreateWorkOrderItemInput[];
}

export interface UpdateWorkOrderInput {
	status?: WorkOrderStatus;
	issue_summary?: string;
	notes?: string | null;
}

export type UpdateWorkOrderItemInput = Partial<Omit<CreateWorkOrderItemInput, 'id'>>;

type WorkOrderRow = Omit<WorkOrder, 'items'>;

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

interface PreparedItem {
	id: string;
	item_type: WorkOrderItemType;
	description: string;
	quantity: number;
	unit_price_cents: number;
	component_type: ComponentType | null;
}

function prepareItem(item: CreateWorkOrderItemInput): PreparedItem {
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
	lineTotalCents(item.quantity, item.unit_price_cents);

	const componentType = item.component_type ?? null;
	if (componentType !== null && !isComponentType(componentType)) {
		throw new Error(`Unknown component type: ${componentType}`);
	}

	return {
		id: item.id ?? crypto.randomUUID(),
		item_type: item.item_type,
		description,
		quantity: item.quantity,
		unit_price_cents: item.unit_price_cents,
		component_type: componentType
	};
}

async function insertItem(connection: SqliteConnection, workOrderId: string, item: PreparedItem): Promise<void> {
	await connection.exec(
		`INSERT INTO work_order_items (id, work_order_id, item_type, description, quantity, unit_price_cents, component_type)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		{
			bind: [
				item.id,
				workOrderId,
				item.item_type,
				item.description,
				item.quantity,
				item.unit_price_cents,
				item.component_type
			]
		}
	);
}

async function loadRow(workOrderId: string): Promise<WorkOrderRow> {
	const [row] = await selectRows<WorkOrderRow>('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);
	if (!row) {
		throw new Error('Work order not found.');
	}
	return row;
}

function loadItems(workOrderId: string): Promise<WorkOrderItem[]> {
	return selectRows<WorkOrderItem>(
		`SELECT id, work_order_id, item_type, description, quantity, unit_price_cents, component_type, created_at
		 FROM work_order_items
		 WHERE work_order_id = ?
		 ORDER BY created_at ASC, rowid ASC`,
		[workOrderId]
	);
}

// Sync replaces a work order wholesale (row + items), so every change queues the full current state.
async function queueWorkOrder(workOrderId: string, action: 'INSERT' | 'UPDATE'): Promise<void> {
	const row = await loadRow(workOrderId);
	const items = await loadItems(workOrderId);
	await appendMutation({
		entity_type: 'work_order',
		entity_id: workOrderId,
		action,
		payload: {
			...row,
			items: items.map(({ id, item_type, description, quantity, unit_price_cents, component_type }) => ({
				id,
				item_type,
				description,
				quantity,
				unit_price_cents,
				component_type
			}))
		}
	});
}

// Re-derive total_cents from the line items (integer math only), bump updated_at, and queue the change.
async function refreshAndQueue(connection: SqliteConnection, workOrderId: string): Promise<void> {
	const totalCents = sumLineTotals(await loadItems(workOrderId));
	await connection.exec('UPDATE work_orders SET total_cents = ?, updated_at = ? WHERE id = ?', {
		bind: [totalCents, new Date().toISOString(), workOrderId]
	});
	await queueWorkOrder(workOrderId, 'UPDATE');
}

// Completing a work order stamps every component its line items are tagged with.
async function stampComponents(connection: SqliteConnection, workOrderId: string): Promise<void> {
	const row = await loadRow(workOrderId);
	const items = await loadItems(workOrderId);
	const componentTypes = new Set<ComponentType>();
	for (const item of items) {
		if (item.component_type) componentTypes.add(item.component_type);
	}

	const servicedOn = todayLocalDate();
	for (const componentType of componentTypes) {
		// shortcut: no completed_at column, so "already stamped" = ledger still links this order; upgrade by adding one.
		const [existing] = await selectRows<{ work_order_id: string | null }>(
			'SELECT work_order_id FROM bike_components WHERE bike_id = ? AND component_type = ?',
			[row.bike_id, componentType]
		);
		if (existing?.work_order_id === workOrderId) continue;
		await upsertBikeComponent(connection, {
			bike_id: row.bike_id,
			component_type: componentType,
			last_serviced_date: servicedOn,
			work_order_id: workOrderId
		});
	}
}

async function assertEditable(workOrderId: string): Promise<void> {
	const row = await loadRow(workOrderId);
	if (LOCKED_STATUSES.includes(row.status)) {
		throw new Error(`Reopen this ${row.status} work order before changing its line items.`);
	}
}

// In the transaction queue so it never sees a sync halfway through rewriting this order's line items.
// Do not call from inside inTransaction.
export function getWorkOrder(workOrderId: string): Promise<WorkOrder | null> {
	return inTransaction(async () => {
		const [row] = await selectRows<WorkOrderRow>('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);
		if (!row) return null;
		return { ...row, items: await loadItems(workOrderId) };
	});
}

export async function listWorkOrders(statuses?: readonly WorkOrderStatus[]): Promise<WorkOrderSummary[]> {
	const filter = statuses && statuses.length > 0 ? statuses : null;
	filter?.forEach(assertWorkOrderStatus);

	return selectRows<WorkOrderSummary>(
		`SELECT wo.*, c.id AS customer_id, c.name AS customer_name, b.brand AS bike_brand, b.model AS bike_model,
		        (SELECT COUNT(*) FROM work_order_items i WHERE i.work_order_id = wo.id) AS item_count
		 FROM work_orders wo
		 JOIN bikes b ON b.id = wo.bike_id
		 JOIN customers c ON c.id = b.customer_id
		 ${filter ? `WHERE wo.status IN (${filter.map(() => '?').join(', ')})` : ''}
		 ORDER BY wo.updated_at DESC, wo.created_at DESC`,
		filter ? [...filter] : []
	);
}

export async function countWorkOrdersByStatus(): Promise<Record<WorkOrderStatus, number>> {
	const counts = Object.fromEntries(WORK_ORDER_STATUSES.map((status) => [status, 0])) as Record<
		WorkOrderStatus,
		number
	>;
	const rows = await selectRows<{ status: WorkOrderStatus; total: number }>(
		'SELECT status, COUNT(*) AS total FROM work_orders GROUP BY status'
	);
	for (const row of rows) counts[row.status] = row.total;
	return counts;
}

export async function createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
	const workOrderId = input.id ?? crypto.randomUUID();
	const status = input.status ?? 'open';
	assertWorkOrderStatus(status);

	const issueSummary = input.issue_summary.trim();
	if (!issueSummary) {
		throw new Error('Work order issue summary is required.');
	}

	const items = input.items.map(prepareItem);
	const totalCents = sumLineTotals(items);

	await inTransaction(async (connection) => {
		await connection.exec(
			`INSERT INTO work_orders (id, bike_id, status, issue_summary, notes, total_cents)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			{ bind: [workOrderId, input.bike_id, status, issueSummary, input.notes ?? null, totalCents] }
		);
		for (const item of items) {
			await insertItem(connection, workOrderId, item);
		}

		await queueWorkOrder(workOrderId, 'INSERT');
		if (status === 'completed') {
			await stampComponents(connection, workOrderId);
		}
	});
	notifyLocalWrite();

	return (await getWorkOrder(workOrderId)) as WorkOrder;
}

// Change status, summary or notes. Moving into "completed" also stamps the bike's component ledger, in the same transaction.
export async function updateWorkOrder(workOrderId: string, input: UpdateWorkOrderInput): Promise<WorkOrder> {
	if (input.status !== undefined) assertWorkOrderStatus(input.status);
	const issueSummary = input.issue_summary?.trim();
	if (issueSummary === '') {
		throw new Error('Work order issue summary is required.');
	}

	await inTransaction(async (connection) => {
		const current = await loadRow(workOrderId);
		const nextStatus = input.status ?? current.status;

		await connection.exec(
			`UPDATE work_orders SET status = ?, issue_summary = ?, notes = ?, updated_at = ? WHERE id = ?`,
			{
				bind: [
					nextStatus,
					issueSummary ?? current.issue_summary,
					input.notes === undefined ? current.notes : input.notes,
					new Date().toISOString(),
					workOrderId
				]
			}
		);

		await queueWorkOrder(workOrderId, 'UPDATE');
		if (nextStatus === 'completed' && current.status !== 'completed') {
			await stampComponents(connection, workOrderId);
		}
	});
	notifyLocalWrite();

	return (await getWorkOrder(workOrderId)) as WorkOrder;
}

export async function deleteWorkOrder(workOrderId: string): Promise<void> {
	await inTransaction(async (connection) => {
		await connection.exec('DELETE FROM work_orders WHERE id = ?', { bind: [workOrderId] });
		await appendMutation({
			entity_type: 'work_order',
			entity_id: workOrderId,
			action: 'DELETE',
			payload: { id: workOrderId }
		});
	});
	notifyLocalWrite();
}

export async function addWorkOrderItem(workOrderId: string, input: CreateWorkOrderItemInput): Promise<WorkOrder> {
	const item = prepareItem(input);

	await inTransaction(async (connection) => {
		await assertEditable(workOrderId);
		await insertItem(connection, workOrderId, item);
		await refreshAndQueue(connection, workOrderId);
	});
	notifyLocalWrite();

	return (await getWorkOrder(workOrderId)) as WorkOrder;
}

export async function updateWorkOrderItem(itemId: string, patch: UpdateWorkOrderItemInput): Promise<WorkOrder> {
	let workOrderId = '';

	await inTransaction(async (connection) => {
		const [current] = await selectRows<WorkOrderItem>('SELECT * FROM work_order_items WHERE id = ?', [itemId]);
		if (!current) {
			throw new Error('Line item not found.');
		}
		workOrderId = current.work_order_id;
		await assertEditable(workOrderId);

		const next = prepareItem({
			id: current.id,
			item_type: patch.item_type ?? current.item_type,
			description: patch.description ?? current.description,
			quantity: patch.quantity ?? current.quantity,
			unit_price_cents: patch.unit_price_cents ?? current.unit_price_cents,
			component_type: patch.component_type === undefined ? current.component_type : patch.component_type
		});

		await connection.exec(
			`UPDATE work_order_items
			 SET item_type = ?, description = ?, quantity = ?, unit_price_cents = ?, component_type = ?
			 WHERE id = ?`,
			{
				bind: [
					next.item_type,
					next.description,
					next.quantity,
					next.unit_price_cents,
					next.component_type,
					itemId
				]
			}
		);
		await refreshAndQueue(connection, workOrderId);
	});
	notifyLocalWrite();

	return (await getWorkOrder(workOrderId)) as WorkOrder;
}

export async function removeWorkOrderItem(itemId: string): Promise<WorkOrder> {
	let workOrderId = '';

	await inTransaction(async (connection) => {
		const [current] = await selectRows<WorkOrderItem>('SELECT * FROM work_order_items WHERE id = ?', [itemId]);
		if (!current) {
			throw new Error('Line item not found.');
		}
		workOrderId = current.work_order_id;
		await assertEditable(workOrderId);

		await connection.exec('DELETE FROM work_order_items WHERE id = ?', { bind: [itemId] });
		await refreshAndQueue(connection, workOrderId);
	});
	notifyLocalWrite();

	return (await getWorkOrder(workOrderId)) as WorkOrder;
}
