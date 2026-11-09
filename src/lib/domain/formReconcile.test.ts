import { describe, expect, it } from 'vitest';
import { reconcileForm } from './formReconcile';

const base = { issue_summary: 'Brakes', notes: 'Old' };

describe('reconcileForm', () => {
	it('takes remote values for fields the mechanic did not touch and keeps typed ones', () => {
		const result = reconcileForm({ issue_summary: 'Brakes rub', notes: 'Old' }, base, {
			issue_summary: 'Brakes',
			notes: 'From phone'
		});

		expect(result.form).toEqual({ issue_summary: 'Brakes rub', notes: 'From phone' });
		expect(result.conflict).toBeNull();
	});

	it('warns when both sides changed a field, keeps the typed text, then allows the next save', () => {
		const form = { issue_summary: 'Brakes', notes: 'From tablet' };
		const fresh = { issue_summary: 'Brakes', notes: 'From phone' };

		const first = reconcileForm(form, base, fresh);
		expect(first.form.notes).toBe('From tablet');
		expect(first.conflict).toContain('notes is now "From phone"');

		expect(reconcileForm(first.form, first.base, fresh).conflict).toBeNull();
	});

	it('does not warn when both sides made the same change', () => {
		const same = { issue_summary: 'Brakes', notes: 'Same' };
		expect(reconcileForm(same, base, same).conflict).toBeNull();
	});
});
