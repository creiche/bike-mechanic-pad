import { describe, expect, it } from 'vitest';
import { componentLabel, daysSince, isComponentType, isServiceDate, todayLocalDate } from './componentTypes';

describe('component types', () => {
	it('recognises known keys and labels them', () => {
		expect(isComponentType('chain')).toBe(true);
		expect(isComponentType('flux_capacitor')).toBe(false);
		expect(componentLabel('rear_shock_service')).toBe('Rear shock service');
		expect(componentLabel('unknown_part')).toBe('unknown_part');
	});

	it('formats the local calendar day, not the UTC day', () => {
		expect(todayLocalDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
	});

	it('counts whole calendar days since a service date', () => {
		const now = new Date(2026, 10, 8, 9, 30);
		expect(daysSince('2026-11-08', now)).toBe(0);
		expect(daysSince('2026-11-01', now)).toBe(7);
		expect(daysSince('2025-11-08', now)).toBe(365);
	});

	it('validates real calendar dates only', () => {
		expect(isServiceDate('2026-02-28')).toBe(true);
		expect(isServiceDate('2026-02-30')).toBe(false);
		expect(isServiceDate('2026-2-3')).toBe(false);
		expect(isServiceDate('')).toBe(false);
	});
});
