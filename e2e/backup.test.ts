import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures';

test('export a backup, clear the database, then restore it', async ({ page }, testInfo) => {
	await page.goto('/customers');
	await page.getByLabel('Name', { exact: true }).fill('Backup Betty');
	await page.getByRole('button', { name: 'Save customer' }).click();
	await expect(page.getByRole('button', { name: /Backup Betty/ })).toBeVisible();

	await page.goto('/settings/backup');
	await expect(page.getByTestId('storage-status')).toContainText('Local OPFS Active');
	await expect(page.getByTestId('storage-status')).toContainText('pending change');

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Export Database Snapshot' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^bike-mechanic-pad-backup-\d{4}-\d{2}-\d{2}\.json$/);
	const backupPath = testInfo.outputPath('backup.json');
	await download.saveAs(backupPath);
	expect(JSON.parse(readFileSync(backupPath, 'utf8')).data.customers[0].name).toBe('Backup Betty');

	// Clear is locked until DELETE is typed exactly.
	const clear = page.getByRole('button', { name: 'Clear Local Database' });
	await expect(clear).toBeDisabled();
	await page.getByLabel('Type DELETE to confirm').fill('delete');
	await expect(clear).toBeDisabled();
	await page.getByLabel('Type DELETE to confirm').fill('DELETE');
	await clear.click();
	await expect(page.getByText('Local database cleared.')).toBeVisible();
	await page.goto('/customers');
	await expect(page.getByText('No customers saved yet.')).toBeVisible();

	// A broken file is rejected without touching anything.
	page.on('dialog', (dialog) => void dialog.accept());
	await page.goto('/settings/backup');
	const badPath = testInfo.outputPath('bad.json');
	writeFileSync(badPath, JSON.stringify({ version: 1, data: { customers: [] } }));
	await page.getByLabel('Restore from Backup').setInputFiles(badPath);
	await expect(page.getByText('Restore failed. Nothing was changed.')).toBeVisible();

	await page.getByLabel('Restore from Backup').setInputFiles(backupPath);
	await expect(page.getByText(/Backup restored from backup\.json/)).toBeVisible();
	await page.goto('/customers');
	await expect(page.getByRole('button', { name: /Backup Betty/ })).toBeVisible();
});
