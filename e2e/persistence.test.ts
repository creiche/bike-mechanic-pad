import { expect, test } from './fixtures';

test('the page is cross-origin isolated, so OPFS can work', async ({ page }) => {
	await page.goto('/customers');

	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('a saved customer and bike survive a reload', async ({ page }) => {
	await page.goto('/customers');
	await expect(page.getByText('No customers saved yet.')).toBeVisible();

	await page.getByLabel('Name', { exact: true }).fill('Miguel Rios');
	await page.getByRole('button', { name: 'Save customer' }).click();
	await page.getByLabel('Brand').fill('Trek');
	await page.getByLabel('Model').fill('Domane');
	await page.getByRole('button', { name: 'Save bike' }).click();
	await expect(page.getByRole('heading', { name: 'Trek Domane' })).toBeVisible();

	await page.reload();

	await expect(page.getByRole('button', { name: /Miguel Rios/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Trek Domane' })).toBeVisible();
});
