import { test, expect } from './fixtures';
import { deviceWithCustomer, openCustomers, pair } from './pairing';

// Needs real WebKit, so it has its own project (see playwright.config.ts) and does not gate CI.
for (const webkitFirst of [true, false]) {
	test(`Chromium and WebKit pair and sync (${webkitFirst ? 'WebKit' : 'Chromium'} shows the first code)`, async ({ newDevice, newWebKitDevice }) => {
		test.setTimeout(120_000);
		const chromium = await deviceWithCustomer(newDevice, 'Chromium Carla');
		const safari = await deviceWithCustomer(newWebKitDevice, 'WebKit Wendy');

		await pair(webkitFirst ? safari : chromium, webkitFirst ? chromium : safari);

		await openCustomers(chromium);
		await openCustomers(safari);
		await expect(chromium.getByRole('button', { name: /WebKit Wendy/ })).toBeVisible({ timeout: 20_000 });
		await expect(safari.getByRole('button', { name: /Chromium Carla/ })).toBeVisible({ timeout: 20_000 });
	});
}
