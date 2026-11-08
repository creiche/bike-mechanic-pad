// Wear parts and service intervals tracked per bike. Stored values are stable keys; labels are display-only.
export const COMPONENT_TYPES = [
	{ value: 'chain', label: 'Chain' },
	{ value: 'cassette', label: 'Cassette' },
	{ value: 'brake_pads', label: 'Brake pads' },
	{ value: 'fork_service', label: 'Fork service' },
	{ value: 'rear_shock_service', label: 'Rear shock service' },
	{ value: 'bottom_bracket', label: 'Bottom bracket' }
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number]['value'];

export function isComponentType(value: unknown): value is ComponentType {
	return COMPONENT_TYPES.some((type) => type.value === value);
}

export function componentLabel(type: string): string {
	return COMPONENT_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

// Local calendar day as YYYY-MM-DD; a service "date" is the mechanic's day, not a UTC instant.
export function todayLocalDate(now: Date = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

// Whole calendar days from a YYYY-MM-DD service date to `now` (local), for "142 days ago" labels.
export function daysSince(serviceDate: string, now: Date = new Date()): number {
	const [year, month, day] = serviceDate.split('-').map(Number);
	const then = Date.UTC(year, month - 1, day);
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((today - then) / 86_400_000);
}

export function isServiceDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
