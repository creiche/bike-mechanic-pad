<script lang="ts">
	import { onMount } from 'svelte';
	import { countPendingOutbox } from '../db/backup';
	import { onLocalWrite } from '../db/localWrites';
	import { syncService } from '../sync/runtime';

	let online = $state(true);
	let persisted = $state<boolean | null>(null); // null = browser cannot say
	let pending = $state<number | null>(null);

	async function refreshPending() {
		try {
			pending = await countPendingOutbox();
		} catch {
			pending = null; // database not available (yet); show nothing rather than a wrong number
		}
	}

	onMount(() => {
		online = navigator.onLine;
		const setOnline = () => (online = navigator.onLine);
		window.addEventListener('online', setOnline);
		window.addEventListener('offline', setOnline);
		void navigator.storage?.persisted?.().then((value) => (persisted = value));
		const stopWrites = onLocalWrite(() => void refreshPending());
		void refreshPending();
		return () => {
			window.removeEventListener('online', setOnline);
			window.removeEventListener('offline', setOnline);
			stopWrites();
		};
	});

	// A finished sync moves the upload cursor, so the pending count changes without a local write.
	$effect(() => {
		void $syncService.lastSyncedAt;
		void refreshPending();
	});
</script>

<div class="hidden items-center gap-3 text-xs font-medium text-neutral-300 md:flex" role="status" data-testid="storage-status">
	{#if pending !== null}
		<span title={persisted === false ? 'The browser may clear local data under disk pressure.' : 'Data is stored on this device.'}>
		<span class="text-emerald-400">&#9679;</span> Local OPFS Active{persisted ? ' (persistent)' : persisted === false ? ' (not persistent)' : ''}
		</span>
		<span>{pending} pending {pending === 1 ? 'change' : 'changes'}</span>
	{/if}
	<span class={online ? 'text-neutral-300' : 'text-amber-300'}>{online ? 'Online' : 'Offline'}</span>
</div>
