import { mkdirSync } from 'node:fs';
import { test as base, webkit, type BrowserContext } from '@playwright/test';

export { expect } from '@playwright/test';

interface DeviceFixtures {
	// A separate browser profile with empty storage, as if it were another device.
	newDevice: () => Promise<BrowserContext>;
	// The same, always on WebKit, for tests that pair two engines.
	newWebKitDevice: () => Promise<BrowserContext>;
}

// WebKit's normal Playwright contexts behave like Private Browsing, where OPFS is unavailable and the database cannot
// open. A persistent profile fixes that, but WebKit keeps OPFS under the home directory rather than the profile, so
// each device also needs its own HOME or they would all share one database.
export const test = base.extend<DeviceFixtures & { opened: BrowserContext[] }>({
	opened: async ({}, use) => {
		const opened: BrowserContext[] = [];
		await use(opened);
		await Promise.all(opened.map((context) => context.close().catch(() => {})));
	},
	newWebKitDevice: async ({ opened }, use, testInfo) => {
		await use(async () => {
			const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
			const home = testInfo.outputPath(`device-${opened.length}`);
			mkdirSync(home, { recursive: true });
			const context = await webkit.launchPersistentContext(home, {
				baseURL,
				viewport,
				userAgent,
				deviceScaleFactor,
				isMobile,
				hasTouch,
				env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home }
			});
			opened.push(context);
			return context;
		});
	},
	newDevice: async ({ browser, browserName, newWebKitDevice, opened }, use) => {
		await use(async () => {
			if (browserName === 'webkit') return newWebKitDevice();
			const context = await browser.newContext();
			opened.push(context);
			return context;
		});
	},
	context: async ({ newDevice }, use) => {
		await use(await newDevice());
	}
});
