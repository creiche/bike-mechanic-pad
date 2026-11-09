<script lang="ts">
	import { describeSync, formatLastSynced, toneClasses } from '../sync/display';
	import { syncService } from '../sync/runtime';

	const display = $derived(describeSync($syncService));
	const tone = $derived(toneClasses[display.tone]);
</script>

<span
	class="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950 px-3 py-1 text-xs font-medium"
	role="status"
	aria-live="polite"
	title={$syncService.error?.message ?? formatLastSynced($syncService.lastSyncedAt)}
>
	<span class="h-2.5 w-2.5 rounded-full {tone.dot}" aria-hidden="true"></span>
	<span class={tone.text}>{display.label}</span>
</span>
