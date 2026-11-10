import { expect, test } from './fixtures';

for (const path of ['/', '/customers', '/settings', '/settings/backup']) {
	test(`${path} fits the screen without sideways scrolling`, async ({ page }) => {
		await page.goto(path);
		await expect(page.locator('main')).toBeVisible();

		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

		expect(overflow).toBeLessThanOrEqual(0);
	});
}
