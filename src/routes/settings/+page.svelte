<script lang="ts">
	import { resolve } from '$app/paths';
	import NearbyDeviceCard from '../../lib/components/NearbyDeviceCard.svelte';
	import WebDavCard from '../../lib/components/WebDavCard.svelte';
	import { inputClass, primaryButton, secondaryButton } from '../../lib/ui';
	import { describeSync, formatLastSynced, toneClasses } from '../../lib/sync/display';
	import { syncService } from '../../lib/sync/runtime';

	const identity = syncService.getIdentity();

	let deviceName = $state(identity.deviceName);
	let errorMessage = $state('');
	let notice = $state('');

	const display = $derived(describeSync($syncService));
	const tone = $derived(toneClasses[display.tone]);
	const connected = $derived($syncService.connection === 'connected');
	const syncing = $derived($syncService.status === 'syncing');
	const summary = $derived($syncService.lastSummary);

	function handleSaveName(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = notice = '';
		try {
			syncService.saveDeviceName(deviceName);
			deviceName = syncService.getIdentity().deviceName;
			notice = 'Device name saved.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	function handleSyncNow() {
		void syncService.syncNow(); // failures land in the store's `error`, shown below
	}
</script>

<main class="min-h-screen bg-workshop-dark p-6 text-slate-100">
	<div class="mx-auto w-full max-w-xl space-y-6">
		<header class="border-b border-neutral-800 pb-4">
			<h1 class="text-2xl font-bold tracking-tight text-amber-500">Settings</h1>
			<p class="text-sm text-neutral-400">Device identity and sync. Everything stays on this device unless you connect.</p>
			<a href={resolve('/settings/services')} class="mt-2 inline-block text-sm text-amber-400 hover:text-amber-300">Service menu &amp; prices &rarr;</a>
			<a href={resolve('/settings/backup')} class="mt-2 block text-sm text-amber-400 hover:text-amber-300">Backup, restore &amp; reset &rarr;</a>
		</header>

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
				<button type="button" class={primaryButton} onclick={handleSyncNow} disabled={!connected || syncing}>
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
					{#if summary.droppedOrphans > 0}
						<dt>Skipped (parent record missing on this device)</dt>
						<dd class="text-right font-mono text-amber-300">{summary.droppedOrphans} changes</dd>
						<dd class="col-span-2 text-xs text-neutral-400">To get these back, restore a recent backup made on a device that has the missing records.</dd>
					{/if}
				</dl>
			{/if}
		</section>

		<form class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="device-heading" onsubmit={handleSaveName}>
			<h2 id="device-heading" class="text-lg font-medium text-neutral-200">This device</h2>

			{#if errorMessage}
				<p role="alert" class="rounded border border-rose-900/50 bg-rose-950/30 p-3 font-mono text-sm text-rose-300">{errorMessage}</p>
			{/if}
			{#if notice}
				<p role="status" class="rounded border border-emerald-900/50 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>
			{/if}

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

			<button type="submit" class={secondaryButton}>Save name</button>
		</form>

		<NearbyDeviceCard />
		<WebDavCard />
	</div>
</main>
