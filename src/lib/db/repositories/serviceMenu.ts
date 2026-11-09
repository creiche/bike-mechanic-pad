import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { isComponentType, type ComponentType } from '../../domain/componentTypes';
import { openDatabase } from '../client';
import { notifyLocalWrite } from '../localWrites';
import { inTransaction } from '../transaction';
import { appendMutation } from './sync';

export const SERVICE_MENU_CATEGORIES = ['labor', 'package', 'part'] as const;
export const SERVICE_MENU_ITEM_TYPES = ['labor', 'part'] as const;

export type ServiceMenuCategory = (typeof SERVICE_MENU_CATEGORIES)[number];
export type ServiceMenuItemType = (typeof SERVICE_MENU_ITEM_TYPES)[number];

// One row of the shop price list. Quick-add copies name, type, price and component_tag onto a work order
// line item, so later menu edits never change existing work orders.
export interface ServiceMenuItem {
	id: string;
	category: ServiceMenuCategory;
	name: string;
	default_price_cents: number;
	item_type: ServiceMenuItemType;
	// Same keys as the component ledger; completing a work order stamps that component.
	component_tag: ComponentType | null;
	// Set when archived: hidden from quick-add but kept for the record.
	archived_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface ServiceMenuItemInput {
	id?: string;
	category: ServiceMenuCategory;
	name: string;
	default_price_cents: number;
	item_type: ServiceMenuItemType;
	component_tag?: ComponentType | null;
}

async function selectRows<T>(sql: string, bind: BindingSpec = []): Promise<T[]> {
	const connection = await openDatabase();
	const result = await connection.exec(sql, { bind, rowMode: 'object', returnValue: 'resultRows' });
	return Array.isArray(result) ? (result as T[]) : [];
}

export async function listServiceMenuItems(includeArchived = false): Promise<ServiceMenuItem[]> {
	return selectRows<ServiceMenuItem>(
		`SELECT * FROM service_menu_items ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
		 ORDER BY category ASC, name COLLATE NOCASE ASC`
	);
}

// Quick-add lookup: every whitespace-separated word must appear in the name or category (case-insensitive).
export function filterServiceMenu(items: readonly ServiceMenuItem[], query: string): ServiceMenuItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		const haystack = `${item.name} ${item.category}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

function validate(input: ServiceMenuItemInput): Required<Omit<ServiceMenuItemInput, 'id'>> {
	const name = input.name.trim();
	if (!name) throw new Error('Service name is required.');
	if (!SERVICE_MENU_CATEGORIES.includes(input.category)) throw new Error(`Invalid category: ${input.category}`);
	if (!SERVICE_MENU_ITEM_TYPES.includes(input.item_type)) throw new Error(`Invalid item type: ${input.item_type}`);
	if (!Number.isSafeInteger(input.default_price_cents) || input.default_price_cents < 0) {
		throw new Error('Default price must be zero or more whole cents.');
	}
	const tag = input.component_tag ?? null;
	if (tag !== null && !isComponentType(tag)) throw new Error(`Unknown component type: ${tag}`);
	return { ...input, name, component_tag: tag };
}

async function loadItem(id: string): Promise<ServiceMenuItem> {
	const [row] = await selectRows<ServiceMenuItem>('SELECT * FROM service_menu_items WHERE id = ?', [id]);
	if (!row) throw new Error('Service menu item not found.');
	return row;
}

// Write the full row and queue it; the whole row is the sync payload (last-write-wins on updated_at).
async function saveItem(row: ServiceMenuItem, action: 'INSERT' | 'UPDATE'): Promise<void> {
	await inTransaction(async (connection) => {
		await connection.exec(
			`INSERT INTO service_menu_items
			   (id, category, name, default_price_cents, item_type, component_tag, archived_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   category = excluded.category, name = excluded.name, default_price_cents = excluded.default_price_cents,
			   item_type = excluded.item_type, component_tag = excluded.component_tag,
			   archived_at = excluded.archived_at, updated_at = excluded.updated_at`,
			{
				bind: [
					row.id,
					row.category,
					row.name,
					row.default_price_cents,
					row.item_type,
					row.component_tag,
					row.archived_at,
					row.created_at,
					row.updated_at
				]
			}
		);
		await appendMutation({ entity_type: 'service_menu_item', entity_id: row.id, action, payload: { ...row } });
	});
	notifyLocalWrite();
}

export async function createServiceMenuItem(input: ServiceMenuItemInput): Promise<ServiceMenuItem> {
	const fields = validate(input);
	const now = new Date().toISOString();
	const row: ServiceMenuItem = {
		id: input.id ?? crypto.randomUUID(),
		...fields,
		archived_at: null,
		created_at: now,
		updated_at: now
	};
	await saveItem(row, 'INSERT');
	return row;
}

export async function updateServiceMenuItem(id: string, input: ServiceMenuItemInput): Promise<ServiceMenuItem> {
	const current = await loadItem(id);
	const row: ServiceMenuItem = { ...current, ...validate(input), updated_at: new Date().toISOString() };
	await saveItem(row, 'UPDATE');
	return row;
}

export async function setServiceMenuItemArchived(id: string, archived: boolean): Promise<ServiceMenuItem> {
	const now = new Date().toISOString();
	const row: ServiceMenuItem = { ...(await loadItem(id)), archived_at: archived ? now : null, updated_at: now };
	await saveItem(row, 'UPDATE');
	return row;
}
