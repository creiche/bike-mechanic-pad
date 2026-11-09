import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (m) => console.log('console:', m.text().slice(0, 150)));
// Deep link, as after a refresh: server answers 404 + 404.html, like GitHub Pages.
await page.goto('http://localhost:4180/bike-mechanic-pad/customers');
await page.getByText('No customers saved yet.').waitFor({ timeout: 15000 });
console.log('isolated:', await page.evaluate(() => crossOriginIsolated));
await page.getByLabel('Name', { exact: true }).fill('Pages Test');
await page.getByRole('button', { name: 'Save customer' }).click();
await page.getByRole('button', { name: /Pages Test/ }).waitFor();
await page.reload();
await page.getByRole('button', { name: /Pages Test/ }).waitFor({ timeout: 15000 });
console.log('survived reload: yes, isolated:', await page.evaluate(() => crossOriginIsolated));
await browser.close();
