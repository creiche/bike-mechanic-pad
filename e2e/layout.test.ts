import { expect, test } from './fixtures';

test('install hint shows in a browser tab and stays dismissed', async ({ page }) => {
	await page.goto('/');
	const hint = page.getByTestId('install-hint');
	await expect(hint).toBeVisible();

	await hint.getByRole('button', { name: 'Not now' }).click();
	await expect(hint).toBeHidden();

	// Reloading while the first-visit service worker still installs crashed WebKit under load.
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect(page.locator('main')).toBeVisible();
	await expect(hint).toBeHidden();
});

for (const path of ['/', '/customers', '/settings', '/settings/backup']) {
	test(`${path} fits the screen without sideways scrolling`, async ({ page }) => {
		await page.goto(path);
		await expect(page.locator('main')).toBeVisible();

		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

		expect(overflow).toBeLessThanOrEqual(0);
	});
}
