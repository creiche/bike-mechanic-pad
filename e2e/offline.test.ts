import { expect, test } from '@playwright/test';

test('after one online visit the app reloads and works with no network', async ({ page, context }) => {
	await page.goto('/customers');
	// The service worker precaches the shell on install; wait until it controls the page.
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

	await context.setOffline(true);
	await page.reload(); // HTML + JS + WASM must all come from the cache
	await expect(page.getByText('No customers saved yet.')).toBeVisible();
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

	// Offline navigation to a deep link works too, and OPFS writes still succeed.
	await page.goto('/customers');
	await page.getByLabel('Name', { exact: true }).fill('Offline Olga');
	await page.getByRole('button', { name: 'Save customer' }).click();
	await expect(page.getByRole('button', { name: /Offline Olga/ })).toBeVisible();
});

test('the web manifest is served and valid', async ({ page, request }) => {
	await page.goto('/customers');
	const href = await page.locator('link[rel=manifest]').getAttribute('href');
	const res = await request.get(new URL(href!, page.url()).href);
	expect(res.ok()).toBe(true);
	const m = await res.json();
	expect(m.name).toBeTruthy();
	for (const icon of m.icons) {
		expect((await request.get(new URL(icon.src, page.url()).href)).ok()).toBe(true);
	}
});
