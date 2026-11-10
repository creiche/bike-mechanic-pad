<script lang="ts">
	import { syncService } from '../sync/runtime';
	import { dangerButton, errorBannerClass, inputClass, primaryButton, secondaryButton } from '../ui';
	import QrCode from './QrCode.svelte';
	import QrScanner from './QrScanner.svelte';

	const nearby = $derived($syncService.nearby);
	const peers = $derived($syncService.peers);
	const anyLinked = $derived(peers.some((peer) => peer.linked));

	// Which path this device took; the session itself only tracks the shared steps.
	let joining = $state(false);
	let scanningReply = $state(false);
	let errorMessage = $state('');
	let pastedCode = $state('');

	let handling = false;
	let lastRejected = ''; // the camera sees an unusable code five times a second; complain once

	$effect(() => {
		if (nearby.phase === 'answering') joining = false;
		if (nearby.phase === 'idle') scanningReply = false;
	});

	async function submit(code: string, action: (code: string) => Promise<void>) {
		if (handling || code === lastRejected) return;
		handling = true;
		errorMessage = '';
		try {
			await action(code);
			lastRejected = '';
			pastedCode = '';
		} catch (error) {
			lastRejected = code;
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			handling = false;
		}
	}

	const useOffer = (code: string) => submit(code, (value) => syncService.nearby.join(value));
	const useReply = (code: string) => submit(code, (value) => syncService.nearby.acceptAnswer(value));

	function pasted(action: (code: string) => Promise<void>) {
		lastRejected = ''; // a person retrying on purpose should always get an answer
		void action(pastedCode.trim());
	}

	async function showMyCode() {
		errorMessage = '';
		try {
			await syncService.nearby.offer();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	function startJoining() {
		errorMessage = '';
		lastRejected = '';
		joining = true;
	}

	function cancel() {
		errorMessage = '';
		joining = false;
		scanningReply = false;
		syncService.nearby.cancel();
	}

	async function forget(deviceId: string) {
		errorMessage = '';
		try {
			await syncService.nearby.forget(deviceId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}
</script>

{#snippet pasteField(action: (code: string) => Promise<void>)}
	<div class="space-y-2">
		<label for="pairing-paste" class="block text-sm text-neutral-300">No camera? Paste the code</label>
		<input id="pairing-paste" class={inputClass} bind:value={pastedCode} autocomplete="off" autocapitalize="off" spellcheck="false" />
		<button type="button" class={secondaryButton} disabled={!pastedCode.trim()} onclick={() => pasted(action)}>Use this code</button>
	</div>
{/snippet}

{#snippet codeToShow(code: string, label: string)}
	<QrCode value={code} {label} />
	<details class="text-sm text-neutral-400">
		<summary class="min-h-12 cursor-pointer py-3">Show as text</summary>
		<p class="break-all rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs select-all" data-testid="pairing-code">{code}</p>
	</details>
{/snippet}

<section class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="nearby-heading">
	<h2 id="nearby-heading" class="text-lg font-medium text-neutral-200">Nearby device</h2>

	{#if errorMessage}
		<p role="alert" class={errorBannerClass}>{errorMessage}</p>
	{/if}

	<div aria-live="polite" class="space-y-4">
		{#if peers.length > 0}
			<ul class="space-y-2">
				{#each peers as peer (peer.deviceId)}
					<li class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-3">
						{#if peer.linked}
							<p class="text-base font-semibold text-emerald-300">Connected to {peer.deviceName}</p>
						{:else}
							<p class="text-base text-neutral-300">{peer.deviceName} (not connected)</p>
						{/if}
						<button type="button" class={secondaryButton} aria-label="Forget {peer.deviceName}" onclick={() => forget(peer.deviceId)}>Forget</button>
					</li>
				{/each}
			</ul>
			<p class="text-sm text-neutral-400">Changes sync while the app is open on connected devices, and this screen stays awake when the device allows it. After a restart, pair with any one connected device and the others reconnect on their own.</p>
			{#if anyLinked}
				<button type="button" class={dangerButton} onclick={() => syncService.nearby.end()}>Disconnect all</button>
			{/if}
		{/if}

		{#if nearby.phase === 'connecting'}
			<p class="text-base font-semibold text-amber-300">Connecting…</p>
			<button type="button" class={secondaryButton} onclick={cancel}>Cancel</button>
		{:else if nearby.phase === 'answering'}
			<p class="text-base font-semibold text-neutral-200">Step 2 of 2: show this code to the first device</p>
			{@render codeToShow(nearby.code, 'Reply code for the first device to scan')}
			<p class="text-sm text-neutral-400">Waiting for the first device to scan it. Keep this screen on.</p>
			<button type="button" class={secondaryButton} onclick={cancel}>Cancel</button>
		{:else if nearby.phase === 'offering'}
			{#if scanningReply}
				<p class="text-base font-semibold text-neutral-200">Step 2 of 2: scan the code on the other device</p>
				<QrScanner onscan={useReply} />
				{@render pasteField(useReply)}
				<div class="flex flex-wrap gap-3">
					<button type="button" class={secondaryButton} onclick={() => (scanningReply = false)}>Back to my code</button>
					<button type="button" class={secondaryButton} onclick={cancel}>Cancel</button>
				</div>
			{:else}
				<p class="text-base font-semibold text-neutral-200">Step 1 of 2: scan this with the other device</p>
				{@render codeToShow(nearby.code, 'Pairing code for the other device to scan')}
				<div class="flex flex-wrap gap-3">
					<button type="button" class={primaryButton} onclick={() => (scanningReply = true)}>Next: scan their code</button>
					<button type="button" class={secondaryButton} onclick={cancel}>Cancel</button>
				</div>
			{/if}
		{:else if joining}
			<p class="text-base font-semibold text-neutral-200">Step 1 of 2: scan the code on the first device</p>
			<!-- Stays open while the reply is prepared: browsers reveal a device's real address only during camera use. -->
			<QrScanner onscan={useOffer} />
			{#if nearby.phase === 'preparing'}
				<p class="text-sm text-amber-300">Preparing the reply…</p>
			{:else}
				{@render pasteField(useOffer)}
			{/if}
			<button type="button" class={secondaryButton} onclick={cancel}>Cancel</button>
		{:else if nearby.phase === 'preparing'}
			<p class="text-base font-semibold text-amber-300">Preparing a code…</p>
		{:else}
			{#if nearby.message}
				<p class="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">{nearby.message}</p>
			{/if}
			<p class="text-sm text-neutral-400">Sync directly with another device on the same Wi-Fi. Nothing leaves your network. Each device scans the other's code.</p>
			<div class="flex flex-wrap gap-3">
				<button type="button" class={primaryButton} onclick={showMyCode}>Show my code</button>
				<button type="button" class={secondaryButton} onclick={startJoining}>Scan a code</button>
			</div>
		{/if}
	</div>
</section>
