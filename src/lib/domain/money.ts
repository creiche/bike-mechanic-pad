// All money in the app is an integer number of cents. These helpers are the only place text and
// cents are converted, so no floating-point arithmetic ever touches a price.

const MONEY_PATTERN = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/;

// "45", "45.5", "$1,234.56" -> cents. Returns null for blank or malformed input.
export function parseCents(input: string): number | null {
	const text = input.trim();
	const match = MONEY_PATTERN.exec(text);
	if (!match || (match[1] === undefined && match[2] === undefined)) {
		return null;
	}

	const whole = Number((match[1] ?? '0').replaceAll(',', ''));
	const fraction = Number((match[2] ?? '').padEnd(2, '0'));
	const cents = whole * 100 + fraction;

	return Number.isSafeInteger(cents) ? cents : null;
}

export function formatCents(cents: number): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const dollars = Math.trunc(abs / 100);
	const remainder = String(abs % 100).padStart(2, '0');

	return `${sign}$${dollars.toLocaleString('en-US')}.${remainder}`;
}

// Cents text for an editable input, without currency symbol or grouping: 4500 -> "45.00".
export function centsToInput(cents: number): string {
	return formatCents(cents).replace(/[$,]/g, '');
}

export function lineTotalCents(quantity: number, unitPriceCents: number): number {
	const total = quantity * unitPriceCents;
	if (!Number.isSafeInteger(total)) {
		throw new Error('Work order item total_cents must be a safe integer.');
	}
	return total;
}

export function sumLineTotals(items: ReadonlyArray<{ quantity: number; unit_price_cents: number }>): number {
	let total = 0;
	for (const item of items) {
		total += lineTotalCents(item.quantity, item.unit_price_cents);
		if (!Number.isSafeInteger(total)) {
			throw new Error('Work order total_cents must be a safe integer.');
		}
	}
	return total;
}
