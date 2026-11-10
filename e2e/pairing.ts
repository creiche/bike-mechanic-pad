import type { BrowserContext, Page } from '@playwright/test';
import { expect } from './fixtures';

export async function deviceWithCustomer(newDevice: () => Promise<BrowserContext>, customer: string): Promise<Page> {
	const page = await (await newDevice()).newPage();
	await page.goto('/customers');
	await page.getByLabel('Name', { exact: true }).fill(customer);
	await page.getByRole('button', { name: 'Save customer' }).click();
	await expect(page.getByRole('button', { name: new RegExp(customer) })).toBeVisible();
	return page;
}

// In-app link, because a full page load would end the nearby connection.
export const openSettings = (page: Page) => page.getByRole('link', { name: 'Sync settings' }).click();
export const openCustomers = (page: Page) => page.getByRole('link', { name: 'Customers' }).first().click();

export async function pasteCode(page: Page, code: string) {
	await page.getByLabel('No camera? Paste the code').fill(code);
	await page.getByRole('button', { name: 'Use this code' }).click();
}

export const expectLinks = (page: Page, count: number) => expect(page.getByText(/^Connected to Device /)).toHaveCount(count, { timeout: 30_000 });

// Making a code waits up to 5 s for the browser to finish finding network addresses, so the default 5 s is too tight.
const CODE_TIMEOUT = 20_000;

// Pairs through the paste box, which is the same flow as scanning without needing a camera.
// `links` is how many devices each side should be connected to afterwards.
export async function pair(first: Page, second: Page, links: [number, number] = [1, 1]) {
	await openSettings(first);
	await openSettings(second);

	await first.getByRole('button', { name: 'Show my code' }).click();
	await expect(first.getByRole('img', { name: 'Pairing code for the other device to scan' })).toBeVisible({ timeout: CODE_TIMEOUT });
	const offer = await first.getByTestId('pairing-code').textContent();

	await second.getByRole('button', { name: 'Scan a code' }).click();
	await pasteCode(second, offer!);
	await expect(second.getByRole('img', { name: 'Reply code for the first device to scan' })).toBeVisible({ timeout: CODE_TIMEOUT });
	const reply = await second.getByTestId('pairing-code').textContent();

	await first.getByRole('button', { name: 'Next: scan their code' }).click();
	await pasteCode(first, reply!);

	await expectLinks(first, links[0]);
	await expectLinks(second, links[1]);
}
