<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { COMPONENT_TYPES, componentLabel, isComponentType } from '../../../lib/domain/componentTypes';
	import { centsToInput, formatCents, parseCents } from '../../../lib/domain/money';
	import {
		createServiceMenuItem,
		listServiceMenuItems,
		SERVICE_MENU_CATEGORIES,
		SERVICE_MENU_ITEM_TYPES,
		setServiceMenuItemArchived,
		updateServiceMenuItem,
		type ServiceMenuItem
	} from '../../../lib/db/repositories/serviceMenu';
	import {
		cardClass,
		errorBannerClass,
		inputClass,
		labelTextClass,
		primaryButton,
		secondaryButton
	} from '../../../lib/ui';

	let items = $state<ServiceMenuItem[]>([]);
	let isLoading = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');
	let editingId = $state<string | null>(null);
	let form = $state(blankForm());

	function blankForm() {
		return { name: '', category: 'labor', item_type: 'labor', price: '', component_tag: '' };
	}

	async function refresh() {
		items = await listServiceMenuItems(true);
	}

	onMount(async () => {
		try {
			await refresh();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	});

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		errorMessage = '';
		try {
			await action();
			await refresh();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function startEdit(item: ServiceMenuItem) {
		editingId = item.id;
		form = {
			name: item.name,
			category: item.category,
			item_type: item.item_type,
			price: centsToInput(item.default_price_cents),
			component_tag: item.component_tag ?? ''
		};
	}

	function reset() {
		editingId = null;
		form = blankForm();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const cents = parseCents(form.price);
		if (cents === null) {
			errorMessage = 'Enter the default price as dollars and cents, like 45.00.';
			return;
		}
		const input = {
			name: form.name,
			category: form.category as ServiceMenuItem['category'],
			item_type: form.item_type as ServiceMenuItem['item_type'],
			default_price_cents: cents,
			component_tag: isComponentType(form.component_tag) ? form.component_tag : null
		};
		const id = editingId;
		void run(async () => {
			if (id) await updateServiceMenuItem(id, input);
			else await createServiceMenuItem(input);
			reset();
		});
	}

	const toggleArchive = (item: ServiceMenuItem) =>
		run(async () => {
			await setServiceMenuItemArchived(item.id, item.archived_at === null);
		});
</script>

<svelte:head>
	<title>Service menu | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
		<a href={resolve('/settings')} class="text-sm text-amber-400 hover:text-amber-300">&larr; Settings</a>
		<h1 class="text-3xl font-bold">Service menu</h1>
		<p class="text-neutral-400">Standard jobs and parts with default prices, used for quick-add on work orders.</p>

		{#if errorMessage}<div class={errorBannerClass} role="alert">{errorMessage}</div>{/if}

		<section class={cardClass} aria-label="Menu items">
			{#if isLoading}
				<p class="text-neutral-400">Loading...</p>
			{:else}
				<ul class="divide-y divide-neutral-800">
					{#each items as item (item.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 py-3 {item.archived_at ? 'opacity-50' : ''}">
							<div class="min-w-0 flex-1">
								<p class="text-base font-medium">{item.name}{item.archived_at ? ' (archived)' : ''}</p>
								<p class="mt-1 flex flex-wrap gap-2 text-xs uppercase tracking-wide text-neutral-400">
									<span class="rounded border border-neutral-700 px-2 py-0.5">{item.category}</span>
									<span class="rounded border border-neutral-700 px-2 py-0.5">{item.item_type}</span>
									{#if item.component_tag}
										<span class="rounded border border-amber-700 bg-amber-950/40 px-2 py-0.5 normal-case text-amber-200">
											{componentLabel(item.component_tag)}
										</span>
									{/if}
								</p>
							</div>
							<p class="text-lg font-semibold">{formatCents(item.default_price_cents)}</p>
							<div class="flex gap-2">
								<button type="button" class={secondaryButton} disabled={busy} aria-label="Edit {item.name}" onclick={() => startEdit(item)}>Edit</button>
								<button type="button" class={secondaryButton} disabled={busy} aria-label="{item.archived_at ? 'Restore' : 'Archive'} {item.name}" onclick={() => toggleArchive(item)}>
									{item.archived_at ? 'Restore' : 'Archive'}
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class={cardClass} aria-label="Item form">
			<form class="space-y-4" onsubmit={submit}>
				<h2 class="text-lg font-semibold">{editingId ? 'Edit service' : 'Add service'}</h2>
				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block text-sm">
						<span class={labelTextClass}>Service name</span>
						<input class={inputClass} type="text" bind:value={form.name} required />
					</label>
					<label class="block text-sm">
						<span class={labelTextClass}>Default price ($)</span>
						<input class={inputClass} type="text" inputmode="decimal" bind:value={form.price} placeholder="45.00" required />
					</label>
					<label class="block text-sm">
						<span class={labelTextClass}>Category</span>
						<select class={inputClass} bind:value={form.category}>
							{#each SERVICE_MENU_CATEGORIES as category (category)}<option value={category}>{category}</option>{/each}
						</select>
					</label>
					<label class="block text-sm">
						<span class={labelTextClass}>Line item type</span>
						<select class={inputClass} bind:value={form.item_type}>
							{#each SERVICE_MENU_ITEM_TYPES as type (type)}<option value={type}>{type}</option>{/each}
						</select>
					</label>
					<label class="block text-sm">
						<span class={labelTextClass}>Component serviced</span>
						<select class={inputClass} bind:value={form.component_tag}>
							<option value="">None</option>
							{#each COMPONENT_TYPES as type (type.value)}<option value={type.value}>{type.label}</option>{/each}
						</select>
					</label>
				</div>
				<div class="flex gap-3">
					<button type="submit" class={primaryButton} disabled={busy}>{editingId ? 'Update service' : 'Add service'}</button>
					{#if editingId}<button type="button" class={secondaryButton} onclick={reset}>Cancel edit</button>{/if}
				</div>
			</form>
		</section>
	</main>
</div>
