import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, lineTotalCents, parseCents, sumLineTotals } from './money';

describe('parseCents', () => {
	it.each([
		['45', 4500],
		['45.5', 4550],
		['45.05', 4505],
		['$1,234.56', 123456],
		['.99', 99],
		['0', 0],
		['  12.00 ', 1200]
	])('parses %s as %i cents without float drift', (text, cents) => {
		expect(parseCents(text)).toBe(cents);
	});

	it.each(['', ' ', '$', '.', 'abc', '-5', '1.234', '1,23', '12,34.00', '1e3'])('rejects %j', (text) => {
		expect(parseCents(text)).toBeNull();
	});

	it('rejects amounts beyond the safe integer range', () => {
		expect(parseCents('99999999999999999999')).toBeNull();
	});

	it('is exact where floating point is not (0.1 + 0.2 style values)', () => {
		expect(parseCents('19.99')).toBe(1999);
		expect(parseCents('1.15')).toBe(115);
	});
});

describe('formatCents', () => {
	it('formats with grouping and two decimals', () => {
		expect(formatCents(0)).toBe('$0.00');
		expect(formatCents(5)).toBe('$0.05');
		expect(formatCents(123456)).toBe('$1,234.56');
		expect(formatCents(-250)).toBe('-$2.50');
	});

	it('round-trips through centsToInput and parseCents', () => {
		for (const cents of [0, 1, 99, 100, 4505, 123456789]) {
			expect(parseCents(centsToInput(cents))).toBe(cents);
		}
	});
});

describe('line totals', () => {
	it('multiplies and sums integer cents', () => {
		expect(lineTotalCents(3, 1999)).toBe(5997);
		expect(sumLineTotals([
			{ quantity: 2, unit_price_cents: 4500 },
			{ quantity: 1, unit_price_cents: 1200 }
		])).toBe(10200);
		expect(sumLineTotals([])).toBe(0);
	});

	it('throws instead of silently losing precision', () => {
		expect(() => lineTotalCents(Number.MAX_SAFE_INTEGER, 2)).toThrow('safe integer');
		expect(() =>
			sumLineTotals([
				{ quantity: 1, unit_price_cents: Number.MAX_SAFE_INTEGER },
				{ quantity: 1, unit_price_cents: 1 }
			])
		).toThrow('safe integer');
	});
});
