import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { deviceWithCustomer, expectLinks, openCustomers, openSettings, pasteCode, pair } from './pairing';

test('two devices pair with codes and exchange records over WebRTC', async ({ newDevice }) => {
	test.setTimeout(120_000);
	const stand = await deviceWithCustomer(newDevice, 'Stand Stella');
	const office = await deviceWithCustomer(newDevice, 'Office Olive');
	await pair(stand, office);

	await openCustomers(stand);
	await openCustomers(office);
	await expect(stand.getByRole('button', { name: /Office Olive/ })).toBeVisible({ timeout: 20_000 });
	await expect(office.getByRole('button', { name: /Stand Stella/ })).toBeVisible({ timeout: 20_000 });

	// The other device leaving is reported, and sync falls back to off.
	await office.context().close();
	await openSettings(stand);
	await expect(stand.getByText(/Pair again to keep syncing/)).toBeVisible({ timeout: 45_000 });
	await stand.context().close();
});

test('three paired devices sync, and a restarted device rejoins all of them from one pairing', async ({ newDevice }) => {
	test.setTimeout(180_000);
	const desk = await deviceWithCustomer(newDevice, 'Desk Dana');
	const stand = await deviceWithCustomer(newDevice, 'Stand Stella');
	const phone = await deviceWithCustomer(newDevice, 'Phone Pat');

	await pair(desk, stand);
	await pair(stand, phone, [2, 1]);
	await pair(desk, phone, [2, 2]);

	// A cold boot: every live link is gone, but the three devices still remember each other.
	await phone.reload();
	await expect(phone.getByText(/\(not connected\)$/)).toHaveCount(2, { timeout: 20_000 });
	await expectLinks(desk, 1);
	await expectLinks(stand, 1);

	// One pairing, with the stand only. The desk link must come back by itself.
	await pair(stand, phone, [2, 2]);
	await expectLinks(desk, 2);

	await openCustomers(phone);
	await phone.getByLabel('Name', { exact: true }).fill('After Reboot');
	await phone.getByRole('button', { name: 'Save customer' }).click();
	await openCustomers(desk);
	await expect(desk.getByRole('button', { name: /After Reboot/ })).toBeVisible({ timeout: 30_000 });
});

test('pairing rejects the wrong code and can be cancelled', async ({ page }) => {
	await page.goto('/settings');
	await page.getByRole('button', { name: 'Scan a code' }).click();
	await pasteCode(page, 'https://example.com/not-a-pairing-code');
	await expect(page.getByRole('alert')).toContainText('not a valid pairing code');

	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('button', { name: 'Show my code' })).toBeVisible();
});

// A small real WebDAV server, so the browser performs genuine CORS preflights. `status` makes every request fail with it.
interface DavServer {
	url: string;
	methods: string[];
}
const ALLOWED_BY_SERVER = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'Authorization, Content-Type, Depth, If-None-Match',
	'access-control-allow-methods': 'OPTIONS, GET, PUT, MKCOL, PROPFIND'
};

const davTest = test.extend<{ dav: (options?: { status?: number; cors?: boolean }) => Promise<DavServer> }>({
	dav: async ({}, use) => {
		const servers: Server[] = [];
		await use(async ({ status, cors = true } = {}) => {
			const files = new Map<string, string>();
			const methods: string[] = [];
			const headers = cors ? ALLOWED_BY_SERVER : {};
			const server = createServer((request, response) => {
				const reply = (code: number, body?: string) => {
					response.writeHead(code, headers);
					response.end(body);
				};
				if (request.method === 'OPTIONS') return reply(204);
				methods.push(request.method!);
				let body = '';
				request.setEncoding('utf8');
				request.on('data', (chunk) => (body += chunk));
				request.on('end', () => {
					const path = request.url!;
					if (status) return reply(status);
					if (request.method === 'MKCOL') return reply(201);
					if (request.method === 'GET') return files.has(path) ? reply(200, files.get(path)) : reply(404);
					if (request.method === 'PUT') {
						if (files.has(path)) return reply(412);
						files.set(path, body);
						return reply(201);
					}
					const hrefs = [...files.keys()].filter((file) => file.startsWith(path)).map((file) => `<d:response><d:href>${file}</d:href></d:response>`);
					reply(207, `<d:multistatus xmlns:d="DAV:">${hrefs.join('')}</d:multistatus>`);
				});
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/files/shop`, methods };
		});
		servers.forEach((server) => server.close());
	}
});

test.describe('WebDAV settings', () => {
	async function fill(page: Page, url: string) {
		await page.goto('/settings');
		await page.getByLabel('WebDAV address').fill(`${url}/`);
		await page.getByLabel('Username').fill('shop');
		await page.getByLabel('Password').fill('app-password');
	}

	davTest('tests the connection, saves it, and reports sync as up to date', async ({ page, dav }) => {
		const server = await dav();
		await fill(page, server.url);

		await page.getByRole('button', { name: 'Test Connection' }).click();
		await expect(page.getByText('Connection works.')).toBeVisible();
		expect(server.methods).toEqual(['MKCOL', 'PROPFIND']);
		await expect(page.locator('main').getByText('Sync off')).toBeVisible();

		await page.getByRole('button', { name: 'Save & Connect' }).click();
		await expect(page.locator('main').getByText('Up to date')).toBeVisible();

		await page.reload();
		await expect(page.getByLabel('WebDAV address')).toHaveValue(server.url);
		await expect(page.locator('main').getByText('Up to date')).toBeVisible();
	});

	davTest('two devices exchange records through the server', async ({ newDevice, dav }) => {
		davTest.setTimeout(90_000);
		const server = await dav();
		const stand = await deviceWithCustomer(newDevice, 'Stand Stella');
		const office = await deviceWithCustomer(newDevice, 'Office Olive');

		for (const device of [stand, office]) {
			await fill(device, server.url);
			await device.getByRole('button', { name: 'Save & Connect' }).click();
			await expect(device.getByText('WebDAV saved.')).toBeVisible();
			await openCustomers(device);
		}

		await expect(office.getByRole('button', { name: /Stand Stella/ })).toBeVisible({ timeout: 30_000 });
		await expect(stand.getByRole('button', { name: /Office Olive/ })).toBeVisible({ timeout: 30_000 });
	});

	davTest('explains rejected credentials', async ({ page, dav }) => {
		await fill(page, (await dav({ status: 401 })).url);
		await page.getByRole('button', { name: 'Test Connection' }).click();
		await expect(page.getByRole('alert')).toContainText('rejected that username or password');
	});

	davTest('explains a server that blocks the app', async ({ page, dav }) => {
		await fill(page, (await dav({ cors: false })).url);
		await page.getByRole('button', { name: 'Test Connection' }).click();
		await expect(page.getByRole('alert')).toContainText('it must allow http://localhost:4173');
	});

	test('refuses an insecure address', async ({ page }) => {
		await page.goto('/settings');
		await page.getByLabel('WebDAV address').fill('http://nas.local/dav');
		await page.getByLabel('Username').fill('shop');
		await page.getByLabel('Password').fill('pw');
		await page.getByRole('button', { name: 'Save & Connect' }).click();
		await expect(page.getByRole('alert')).toContainText('must start with https://');
	});
});
