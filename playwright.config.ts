import { defineConfig, devices } from '@playwright/test';

// Browser tests run against the PRODUCTION build (vite preview), because that is what ships:
// OPFS only works with the COOP/COEP headers, and these tests prove the built app still gets them.
export default defineConfig({
	testDir: 'e2e',
	// Shared CI runners are slow and the WebRTC pairing tests are timing-sensitive: one worker, one retry.
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : undefined,
	webServer: {
		command: 'npm run build && npm run preview -- --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: false,
		timeout: 120_000
	},
	use: { baseURL: 'http://localhost:4173' },
	// Each test gets a fresh browser context, so each starts with empty OPFS.
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /crossEngine/ },
		{ name: 'webkit', use: { browserName: 'webkit' }, testIgnore: /crossEngine/ },
		// Phone screens and touch, on the desktop browser engines. Not real devices.
		{ name: 'iphone', use: { ...devices['iPhone 15'] }, testIgnore: /crossEngine/ },
		{ name: 'android', use: { ...devices['Pixel 7'] }, testIgnore: /crossEngine/ },
		// Drives Chromium and WebKit together; the only project that needs both browsers. It runs on GitHub's macOS
		// runner, which blocks mDNS, so Chromium uses its real address here (see e2e/fixtures.ts for WebKit).
		{
			name: 'cross-engine',
			use: { browserName: 'chromium', launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } },
			testMatch: /crossEngine/
		}
	]
});
