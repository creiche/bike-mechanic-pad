import { mkdirSync } from 'node:fs';
import { test as base, webkit, type BrowserContext } from '@playwright/test';

export { expect } from '@playwright/test';

interface DeviceFixtures {
	// A separate browser profile with empty storage, as if it were another device.
	newDevice: () => Promise<BrowserContext>;
	// The same, always on WebKit, for tests that pair two engines.
	newWebKitDevice: () => Promise<BrowserContext>;
}

// Test browsers cannot pair over mDNS (.local) names here: Playwright's WebKit never resolves them, and GitHub's macOS
// runner blocks the multicast they need. WebKit uses its real address once a page has camera access, as on a device that
// has just scanned a QR code, so each WebKit page asks for the camera first. mDNS stays under test in the Linux Chromium job.
function exposeRealAddress() {
	void navigator.mediaDevices?.getUserMedia({ video: true }).then(
		(stream) => stream.getTracks().forEach((track) => track.stop()),
		() => {}
	);
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
				permissions: ['camera'],
				env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home }
			});
			await context.addInitScript(exposeRealAddress);
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
