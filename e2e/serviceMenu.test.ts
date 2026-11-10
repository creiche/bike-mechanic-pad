import { expect, test } from './fixtures';

test('quick-add from the service menu, override the price, and a new menu item appears', async ({ page }) => {
	await page.goto('/settings/services');
	await page.getByLabel('Service name').fill('Wheel True');
	await page.getByLabel('Default price ($)').fill('25.00');
	await page.getByRole('button', { name: 'Add service' }).click();
	await expect(page.getByText('Wheel True')).toBeVisible();

	await page.goto('/customers');
	await page.getByLabel('Name', { exact: true }).fill('Sam Lee');
	await page.getByRole('button', { name: 'Save customer' }).click();
	await page.getByLabel('Brand').fill('Giant');
	await page.getByLabel('Model').fill('Defy');
	await page.getByRole('button', { name: 'Save bike' }).click();
	await page.getByRole('link', { name: 'New work order' }).click();
	await page.getByLabel('Issue summary').fill('Brakes spongy');
	await page.getByRole('button', { name: 'Create work order' }).click();
	await expect(page.getByRole('heading', { name: 'Sam Lee' })).toBeVisible();

	await page.getByLabel('Search service menu').fill('brake bleed');
	await page.getByRole('button', { name: /Hydraulic Brake Bleed/ }).click();
	await expect(page.getByText('1 × $35.00')).toBeVisible();

	// Override the preset price through the normal edit flow.
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Unit price ($)').fill('40.00');
	await page.getByRole('button', { name: 'Update item' }).click();
	await expect(page.getByText('1 × $40.00')).toBeVisible();

	await page.getByRole('button', { name: 'Completed', exact: true }).click();
	await expect(page.getByText('Service ledger updated: Brake bleed.')).toBeVisible();
});
