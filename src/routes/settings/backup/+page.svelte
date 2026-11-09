<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		backupFilename,
		clearLocalDatabase,
		createBackupJson,
		restoreBackup,
		SnapshotValidationError
	} from '../../../lib/db/backup';
	import { syncService } from '../../../lib/sync/runtime';
	import {
		cardClass,
		dangerButton,
		errorBannerClass,
		inputClass,
		labelTextClass,
		primaryButton
	} from '../../../lib/ui';

	let busy = $state(false);
	let errorMessage = $state('');
	let problems = $state<string[]>([]);
	let notice = $state('');
	let confirmText = $state('');

	async function run(action: () => Promise<string>) {
		if (busy) return;
		busy = true;
		errorMessage = '';
		problems = [];
		notice = '';
		try {
			notice = await action();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			if (error instanceof SnapshotValidationError) {
				errorMessage = 'Restore failed. Nothing was changed.';
				problems = error.problems;
			}
		} finally {
			busy = false;
		}
	}

	function exportBackup() {
		void run(async () => {
			const json = await createBackupJson();
			const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = backupFilename();
			document.body.append(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
			return `Backup saved as ${link.download}.`;
		});
	}

	function restoreFromFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // lets the same file be picked again
		if (!file) return;
		void run(async () => {
			const json = await file.text();
			if (!window.confirm(`Replace ALL data on this device with the backup in "${file.name}"?`)) {
				return 'Restore cancelled.';
			}
			const identity = syncService.getIdentity();
			await restoreBackup(json, `pull:${identity.deviceId}`, identity.deviceName);
			return `Backup restored from ${file.name}.`;
		});
	}

	function clearDatabase() {
		void run(async () => {
			await clearLocalDatabase();
			confirmText = '';
			return 'Local database cleared.';
		});
	}
</script>

<svelte:head>
	<title>Backup | bike-mechanic-pad</title>
</svelte:head>

<main class="min-h-screen bg-neutral-950 p-4 text-neutral-100 sm:p-6">
	<div class="mx-auto max-w-2xl space-y-6">
		<a href={resolve('/settings')} class="text-sm text-amber-400 hover:text-amber-300">&larr; Settings</a>
		<h1 class="text-3xl font-bold">Backup &amp; restore</h1>

		{#if errorMessage}
			<div class={errorBannerClass} role="alert">
				{errorMessage}
				{#if problems.length > 0}
					<ul class="mt-2 list-disc pl-5">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>
				{/if}
			</div>
		{/if}
		{#if notice}
			<div class="rounded-md border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200" role="status">{notice}</div>
		{/if}

		<section class={cardClass} aria-label="Export">
			<h2 class="text-lg font-semibold">Export</h2>
			<p class="mb-4 mt-1 text-sm text-neutral-400">Saves every customer, bike, work order, service menu item and ledger entry to a JSON file.</p>
			<button type="button" class={primaryButton} disabled={busy} onclick={exportBackup}>Export Database Snapshot</button>
		</section>

		<section class={cardClass} aria-label="Restore">
			<h2 class="text-lg font-semibold">Restore</h2>
			<p class="mb-4 mt-1 text-sm text-neutral-400">Replaces everything on this device with the contents of a backup file. The file is checked first; a bad file changes nothing.</p>
			<label class="block text-sm">
				<span class={labelTextClass}>Restore from Backup</span>
				<input class={inputClass} type="file" accept="application/json,.json" disabled={busy} onchange={restoreFromFile} />
			</label>
		</section>

		<section class="{cardClass} border-rose-900" aria-label="Clear database">
			<h2 class="text-lg font-semibold text-rose-300">Clear local database</h2>
			<p class="mb-4 mt-1 text-sm text-neutral-400">Deletes all shop data on this device. Export a backup first; this cannot be undone.</p>
			<label class="mb-4 block text-sm">
				<span class={labelTextClass}>Type DELETE to confirm</span>
				<input class={inputClass} type="text" bind:value={confirmText} autocomplete="off" autocapitalize="off" spellcheck="false" />
			</label>
			<button type="button" class={dangerButton} disabled={busy || confirmText !== 'DELETE'} onclick={clearDatabase}>Clear Local Database</button>
		</section>
	</div>
</main>
