<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { formatCents } from '../lib/domain/money';
	import {
		ACTIVE_STATUSES,
		STATUS_BADGE_CLASSES,
		STATUS_LABELS
	} from '../lib/domain/workOrderStatus';
	import {
		countWorkOrdersByStatus,
		listWorkOrders,
		WORK_ORDER_STATUSES,
		type WorkOrderStatus,
		type WorkOrderSummary
	} from '../lib/db/repositories/workOrders';
	import { errorBannerClass, primaryButton } from '../lib/ui';

	type Filter = 'active' | 'all' | WorkOrderStatus;

	let filter = $state<Filter>('active');
	let orders = $state<WorkOrderSummary[]>([]);
	let counts = $state<Record<WorkOrderStatus, number> | null>(null);
	let isLoading = $state(true);
	let errorMessage = $state('');
	let requestId = 0;

	const filterOptions = $derived.by(() => {
		const total = counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : null;
		const active = counts ? ACTIVE_STATUSES.reduce((sum, status) => sum + counts![status], 0) : null;
		return [
			{ value: 'active' as Filter, label: 'Active', count: active },
			...WORK_ORDER_STATUSES.map((status) => ({
				value: status as Filter,
				label: STATUS_LABELS[status],
				count: counts?.[status] ?? null
			})),
			{ value: 'all' as Filter, label: 'All', count: total }
		];
	});

	onMount(load);

	async function load() {
		// Ignore replies from a filter the user has already moved away from.
		const thisRequest = ++requestId;
		isLoading = true;
		errorMessage = '';

		try {
			const statuses = filter === 'all' ? undefined : filter === 'active' ? ACTIVE_STATUSES : [filter];
			const [rows, statusCounts] = await Promise.all([listWorkOrders(statuses), countWorkOrdersByStatus()]);
			if (thisRequest !== requestId) return;
			orders = rows;
			counts = statusCounts;
		} catch (error) {
			if (thisRequest !== requestId) return;
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			if (thisRequest === requestId) isLoading = false;
		}
	}

	function selectFilter(next: Filter) {
		filter = next;
		void load();
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<svelte:head>
	<title>Work orders | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-7xl p-4 sm:p-6">
		<header class="mb-6 flex flex-col gap-4 border-b border-neutral-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
			<div>
				<p class="text-xs uppercase tracking-[0.2em] text-amber-400">Shop floor</p>
				<h1 class="mt-2 text-3xl font-bold text-neutral-50">Work orders</h1>
			</div>
			<a href={resolve('/work-orders/new')} class={primaryButton}>+ New work order</a>
		</header>

		<div class="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
			{#each filterOptions as option (option.value)}
				<button
					type="button"
					aria-pressed={filter === option.value}
					class="min-h-12 rounded-full border px-4 text-base font-medium transition {filter === option.value
						? 'border-amber-500 bg-amber-500 text-neutral-950'
						: 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800'}"
					onclick={() => selectFilter(option.value)}
				>
					{option.label}
					{#if option.count !== null}
						<span class="ml-1 text-sm opacity-75">{option.count}</span>
					{/if}
				</button>
			{/each}
		</div>

		{#if errorMessage}
			<div class="mb-6 {errorBannerClass}">{errorMessage}</div>
		{/if}

		{#if isLoading && orders.length === 0}
			<p class="text-neutral-400">Loading work orders...</p>
		{:else if orders.length === 0 && !errorMessage}
			<div class="rounded-lg border border-dashed border-neutral-700 bg-neutral-900/40 p-10 text-center text-neutral-400">
				No work orders here yet.
			</div>
		{:else}
			<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
				{#each orders as order (order.id)}
					<li>
						<a
							href={resolve('/work-orders/[id]', { id: order.id })}
							class="flex h-full flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-lg shadow-black/20 transition hover:border-amber-500/60 hover:bg-neutral-800/70"
						>
							<div class="flex items-start justify-between gap-3">
								<span class="rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide {STATUS_BADGE_CLASSES[order.status]}">
									{STATUS_LABELS[order.status]}
								</span>
								<span class="text-xs text-neutral-500">{formatDate(order.updated_at)}</span>
							</div>
							<div>
								<h2 class="text-xl font-semibold text-neutral-50">{order.customer_name}</h2>
								<p class="text-base text-neutral-300">{order.bike_brand} {order.bike_model}</p>
							</div>
							<p class="line-clamp-2 flex-1 text-base text-neutral-200">{order.issue_summary}</p>
							<div class="flex items-end justify-between border-t border-neutral-800 pt-3">
								<span class="text-sm text-neutral-400">
									{order.item_count} line item{order.item_count === 1 ? '' : 's'}
								</span>
								<span class="text-2xl font-bold text-amber-400">{formatCents(order.total_cents)}</span>
							</div>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</main>
</div>
