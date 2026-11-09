import { expect, test } from '@playwright/test';

test('work order flow: totals in cents, completion stamps the bike ledger, dashboard filters by status', async ({ page }) => {
	await page.goto('/customers');
	await page.getByLabel('Name', { exact: true }).fill('Ana Ruiz');
	await page.getByRole('button', { name: 'Save customer' }).click();
	await page.getByLabel('Brand').fill('Trek');
	await page.getByLabel('Model').fill('Domane');
	await page.getByRole('button', { name: 'Save bike' }).click();
	await expect(page.getByRole('heading', { name: 'Trek Domane' })).toBeVisible();

	await page.getByRole('link', { name: 'New work order' }).click();
	await page.getByLabel('Issue summary').fill('Chain skipping');
	await page.getByRole('button', { name: 'Create work order' }).click();
	await expect(page.getByRole('heading', { name: 'Ana Ruiz' })).toBeVisible();

	const unsavedNotes = page.getByLabel('Notes', { exact: true });
	await unsavedNotes.fill('Stiff link on the rear');

	await page.getByLabel('Description').fill('11-speed chain');
	await page.getByLabel('Quantity').fill('2');
	await page.getByLabel('Unit price ($)').fill('35.55');
	await page.getByLabel('Component serviced').selectOption('chain');
	await page.getByRole('button', { name: 'Add item' }).click();
	await expect(page.getByText('$71.10').first()).toBeVisible();
	await expect(unsavedNotes).toHaveValue('Stiff link on the rear');

	await page.getByRole('button', { name: 'Completed', exact: true }).click();
	await expect(page.getByText('Service ledger updated: Chain.')).toBeVisible();
	await expect(unsavedNotes).toHaveValue('Stiff link on the rear');
	await expect(page.getByRole('link', { name: /^Work order [0-9a-f]{8}$/ })).toBeVisible();

	await page.getByRole('link', { name: 'Work orders', exact: true }).first().click();
	await expect(page.getByText('No work orders here yet.')).toBeVisible();
	await page.getByRole('button', { name: /^Completed/ }).click();
	await expect(page.getByRole('heading', { name: 'Ana Ruiz' })).toBeVisible();
	await expect(page.getByText('$71.10')).toBeVisible();

	await page.reload();
	await page.getByRole('button', { name: /^Completed/ }).click();
	await expect(page.getByText('Chain skipping')).toBeVisible();
});
