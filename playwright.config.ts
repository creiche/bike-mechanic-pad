import { defineConfig } from '@playwright/test';

// Browser tests run against the PRODUCTION build (vite preview), because that is what ships:
// OPFS only works with the COOP/COEP headers, and these tests prove the built app still gets them.
export default defineConfig({
	testDir: 'e2e',
	webServer: {
		command: 'npm run build && npm run preview -- --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	},
	use: { baseURL: 'http://localhost:4173' },
	// Each test gets a fresh browser context, so each starts with empty OPFS.
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
