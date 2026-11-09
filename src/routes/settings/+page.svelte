<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { dangerButton, inputClass, primaryButton, secondaryButton } from '../../lib/ui';
	import { describeSync, formatLastSynced, toneClasses } from '../../lib/sync/display';
	import { syncService } from '../../lib/sync/runtime';
	import { DEFAULT_FOLDER_PATH } from '../../lib/sync/settings';

	const identity = syncService.getIdentity();
	const saved = syncService.getSettings();

	let appKey = $state(saved.appKey);
	let folderPath = $state(saved.folderPath || DEFAULT_FOLDER_PATH);
	let deviceName = $state(identity.deviceName);
	let busy = $state(false);
	let errorMessage = $state('');
	let notice = $state('');
	let redirectUri = $state('');

	const display = $derived(describeSync($syncService));
	const tone = $derived(toneClasses[display.tone]);
	const connected = $derived($syncService.connection === 'connected');
	const syncing = $derived($syncService.status === 'syncing');
	const summary = $derived($syncService.lastSummary);


	onMount(async () => {
		redirectUri = new URL(resolve('/settings'), location.origin).href;

		// Dropbox sends the user back here with ?code=... (or ?error=...) after the consent screen.
		const params = new URLSearchParams(location.search);
		if (params.has('code') || params.has('error')) {
			const callbackUrl = location.href;
			replaceState(resolve('/settings'), {}); // drop the one-time code from the address bar
			await run(async () => {
				await syncService.completeAuthorization(callbackUrl);
				notice = 'Dropbox connected.';
			});
		}
	});

	// Shared wrapper: one operation at a time, and any failure becomes a visible message.
	async function run(action: () => Promise<void>): Promise<boolean> {
		busy = true;
		errorMessage = '';
		notice = '';
		try {
			await action();
			return true;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			busy = false;
		}
	}

	async function persist(): Promise<void> {
		await syncService.saveSettings({ appKey, folderPath, deviceName });
		const current = syncService.getSettings();
		appKey = current.appKey;
		folderPath = current.folderPath;
		deviceName = syncService.getIdentity().deviceName;
	}

	function handleSave(event: SubmitEvent) {
		event.preventDefault();
		void run(async () => {
			await persist();
			notice = 'Settings saved.';
		});
	}

	async function handleConnect() {
		if (!appKey.trim()) {
			errorMessage = 'Enter your Dropbox app key first.';
			return;
		}
		let target = '';
		const ok = await run(async () => {
			await persist();
			target = await syncService.beginAuthorization();
		});
		if (ok) location.assign(target);
	}

	function handleDisconnect() {
		if (!confirm('Disconnect Dropbox? Data on this device is kept; syncing stops until you reconnect.')) return;
		void run(async () => {
			await syncService.disconnect();
			notice = 'Dropbox disconnected.';
		});
	}

	function handleSyncNow() {
		void run(async () => {
			await syncService.syncNow(); // failures land in the store's `error`, shown below
		});
	}
</script>

<main class="min-h-screen bg-workshop-dark p-6 text-slate-100">
	<div class="mx-auto w-full max-w-xl space-y-6">
		<header class="border-b border-neutral-800 pb-4">
			<h1 class="text-2xl font-bold tracking-tight text-amber-500">Settings</h1>
			<p class="text-sm text-neutral-400">Device identity and Dropbox sync. Everything stays on this device unless you connect.</p>
			<a href={resolve('/settings/services')} class="mt-2 inline-block text-sm text-amber-400 hover:text-amber-300">Service menu &amp; prices &rarr;</a>
			<a href={resolve('/settings/backup')} class="mt-2 block text-sm text-amber-400 hover:text-amber-300">Backup, restore &amp; reset &rarr;</a>
		</header>

		{#if errorMessage}
			<p role="alert" class="rounded border border-rose-900/50 bg-rose-950/30 p-3 font-mono text-sm text-rose-300">{errorMessage}</p>
		{/if}
		{#if notice}
			<p role="status" class="rounded border border-emerald-900/50 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>
		{/if}

		<section class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="sync-status-heading">
			<h2 id="sync-status-heading" class="text-lg font-medium text-neutral-200">Sync status</h2>

			<div class="flex items-center justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-3">
				<div class="flex items-center gap-3" role="status" aria-live="polite">
					<span class="h-3 w-3 rounded-full {tone.dot}" aria-hidden="true"></span>
					<div>
						<p class="text-base font-semibold {tone.text}">{display.label}</p>
						<p class="text-xs text-neutral-500">{formatLastSynced($syncService.lastSyncedAt)}</p>
					</div>
				</div>
				<button
					type="button"
					class={primaryButton}
					onclick={handleSyncNow}
					disabled={!connected || syncing}
				>
					{syncing ? 'Syncing…' : 'Sync Now'}
				</button>
			</div>

			{#if $syncService.error}
				<p class="rounded border border-rose-900/50 bg-rose-950/30 p-3 font-mono text-xs text-rose-300">
					{$syncService.error.message}
				</p>
			{/if}

			{#if summary}
				<dl class="grid grid-cols-2 gap-2 text-sm text-neutral-400">
					<dt>Sent</dt>
					<dd class="text-right font-mono text-neutral-200">{summary.pushedDeltas} changes</dd>
					<dt>Received</dt>
					<dd class="text-right font-mono text-neutral-200">{summary.appliedDeltas} changes</dd>
				</dl>
			{/if}
		</section>

		<form class="space-y-6" onsubmit={handleSave}>
			<section class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="device-heading">
				<h2 id="device-heading" class="text-lg font-medium text-neutral-200">This device</h2>

				<div class="space-y-1">
					<label for="device-name" class="text-sm text-neutral-300">Device name</label>
					<input id="device-name" class={inputClass} bind:value={deviceName} required maxlength="60" autocomplete="off" />
				</div>

				<div class="space-y-1">
					<p class="text-sm text-neutral-300">Device ID</p>
					<p class="break-all rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-neutral-400">
						{identity.deviceId}
					</p>
				</div>
			</section>

			<section class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="dropbox-heading">
				<h2 id="dropbox-heading" class="text-lg font-medium text-neutral-200">Dropbox</h2>

				<div class="space-y-1">
					<label for="app-key" class="text-sm text-neutral-300">App key</label>
					<input
						id="app-key"
						class={inputClass}
						bind:value={appKey}
						placeholder="From your Dropbox app console"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
					/>
				</div>

				<div class="space-y-1">
					<label for="folder-path" class="text-sm text-neutral-300">Sync folder</label>
					<input
						id="folder-path"
						class={inputClass}
						bind:value={folderPath}
						placeholder={DEFAULT_FOLDER_PATH}
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
					/>
					<p class="text-xs text-neutral-500">Use the same folder on every device. Changing it after syncing starts a fresh folder; only do that on purpose.</p>
				</div>

				{#if redirectUri}
					<div class="space-y-1">
						<p class="text-sm text-neutral-300">Redirect URI to register in Dropbox</p>
						<p class="break-all rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-neutral-400">{redirectUri}</p>
					</div>
				{/if}

				<div class="flex flex-wrap gap-3">
					<button type="submit" class={secondaryButton} disabled={busy}>
						Save
					</button>
					{#if connected}
						<button
							type="button"
							class={dangerButton}
							onclick={handleDisconnect}
							disabled={busy}
						>
							Disconnect / Revoke Access
						</button>
					{:else}
						<button
							type="button"
							class={primaryButton}
							onclick={handleConnect}
							disabled={busy}
						>
							Save &amp; Connect to Dropbox
						</button>
					{/if}
				</div>
			</section>
		</form>
	</div>
</main>
