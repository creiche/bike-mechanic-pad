import { isComponentType, type ComponentType } from '../../domain/componentTypes';
import { selectRows } from '../client';
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

export async function listServiceMenuItems(includeArchived = false): Promise<ServiceMenuItem[]> {
	return inTransaction(() =>
		selectRows<ServiceMenuItem>(
			`SELECT * FROM service_menu_items ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
			 ORDER BY category ASC, name COLLATE NOCASE ASC`
		)
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

// Returns ONLY the editable fields (never id/archived_at/timestamps) so spreading it over a row cannot clobber them.
function validate(input: ServiceMenuItemInput): Pick<ServiceMenuItem, 'name' | 'category' | 'item_type' | 'default_price_cents' | 'component_tag'> {
	const name = input.name.trim();
	if (!name) throw new Error('Service name is required.');
	if (!SERVICE_MENU_CATEGORIES.includes(input.category)) throw new Error(`Invalid category: ${input.category}`);
	if (!SERVICE_MENU_ITEM_TYPES.includes(input.item_type)) throw new Error(`Invalid item type: ${input.item_type}`);
	if (!Number.isSafeInteger(input.default_price_cents) || input.default_price_cents < 0) {
		throw new Error('Default price must be zero or more whole cents.');
	}
	const tag = input.component_tag ?? null;
	if (tag !== null && !isComponentType(tag)) throw new Error(`Unknown component type: ${tag}`);
	return { name, category: input.category, item_type: input.item_type, default_price_cents: input.default_price_cents, component_tag: tag };
}

async function loadItem(id: string): Promise<ServiceMenuItem> {
	const [row] = await selectRows<ServiceMenuItem>('SELECT * FROM service_menu_items WHERE id = ?', [id]);
	if (!row) throw new Error('Service menu item not found.');
	return row;
}

// Write the full row and queue it; the whole row is the sync payload (last-write-wins on updated_at).
// `build` runs inside the transaction so an edit never writes back fields read before a sync landed.
async function saveItem(
	action: 'INSERT' | 'UPDATE',
	build: () => ServiceMenuItem | Promise<ServiceMenuItem>
): Promise<ServiceMenuItem> {
	const saved = await inTransaction(async (connection) => {
		const row = await build();
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
		return row;
	});
	notifyLocalWrite();
	return saved;
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
	return saveItem('INSERT', () => row);
}

export async function updateServiceMenuItem(id: string, input: ServiceMenuItemInput): Promise<ServiceMenuItem> {
	const fields = validate(input);
	return saveItem('UPDATE', async () => ({ ...(await loadItem(id)), ...fields, updated_at: new Date().toISOString() }));
}

export async function setServiceMenuItemArchived(id: string, archived: boolean): Promise<ServiceMenuItem> {
	return saveItem('UPDATE', async () => {
		const now = new Date().toISOString();
		return { ...(await loadItem(id)), archived_at: archived ? now : null, updated_at: now };
	});
}
