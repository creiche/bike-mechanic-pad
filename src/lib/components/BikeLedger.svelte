<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		COMPONENT_TYPES,
		daysSince,
		todayLocalDate,
		type ComponentType
	} from '../domain/componentTypes';
	import {
		deleteBikeComponent,
		getBikeComponents,
		logComponentService,
		type BikeComponent
	} from '../db/repositories/bikeComponents';
	import { dangerButton, errorBannerClass, inputClass, labelTextClass, primaryButton, secondaryButton } from '../ui';

	let { bikeId }: { bikeId: string } = $props();

	let components = $state<BikeComponent[]>([]);
	let isLoading = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');
	let loggingType = $state<ComponentType | null>(null);
	let logDate = $state(todayLocalDate());

	const byType = $derived(new Map(components.map((component) => [component.component_type, component])));

	onMount(load);

	async function load() {
		try {
			components = await getBikeComponents(bikeId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	}

	function startLogging(type: ComponentType) {
		loggingType = type;
		logDate = todayLocalDate();
		errorMessage = '';
	}

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		errorMessage = '';
		try {
			await action();
			await load();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function saveLog(event: SubmitEvent, type: ComponentType) {
		event.preventDefault();
		void run(async () => {
			await logComponentService({ bike_id: bikeId, component_type: type, last_serviced_date: logDate });
			loggingType = null;
		});
	}

	function agoLabel(date: string): string {
		const days = daysSince(date);
		if (days <= 0) return 'today';
		return days === 1 ? '1 day ago' : `${days} days ago`;
	}
</script>

<section aria-label="Component service ledger" class="space-y-2">
	{#if errorMessage}
		<div class={errorBannerClass}>{errorMessage}</div>
	{/if}

	{#if isLoading}
		<p class="text-sm text-neutral-400">Loading service history...</p>
	{:else}
		<ul class="divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-950/60">
			{#each COMPONENT_TYPES as type (type.value)}
				{@const entry = byType.get(type.value)}
				<li class="space-y-3 p-3">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p class="font-medium text-neutral-100">{type.label}</p>
							{#if entry}
								<p class="text-sm text-neutral-300">
									{entry.last_serviced_date}
									<span class="text-neutral-500">({agoLabel(entry.last_serviced_date)})</span>
									&middot;
									{#if entry.work_order_id}
										<a
											class="text-amber-400 underline underline-offset-2 hover:text-amber-300"
											href={resolve('/work-orders/[id]', { id: entry.work_order_id })}
										>
											Work order {entry.work_order_id.slice(0, 8)}
										</a>
									{:else}
										<span class="text-neutral-400">Manual entry</span>
									{/if}
								</p>
							{:else}
								<p class="text-sm text-neutral-500">No service recorded</p>
							{/if}
						</div>
						<div class="flex gap-2">
							<button type="button" class={secondaryButton} disabled={busy} onclick={() => startLogging(type.value)}>
								Log service
							</button>
							{#if entry}
								<button
									type="button"
									class={dangerButton}
									disabled={busy}
									aria-label="Clear {type.label} record"
									onclick={() => run(() => deleteBikeComponent(entry.id))}
								>
									Clear
								</button>
							{/if}
						</div>
					</div>

					{#if loggingType === type.value}
						<form class="flex flex-wrap items-end gap-3" onsubmit={(event) => saveLog(event, type.value)}>
							<label class="block text-sm">
								<span class={labelTextClass}>Serviced on</span>
								<input class={inputClass} type="date" bind:value={logDate} required />
							</label>
							<button type="submit" class={primaryButton} disabled={busy}>Save</button>
							<button type="button" class={secondaryButton} onclick={() => (loggingType = null)}>Cancel</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
