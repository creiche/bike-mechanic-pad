<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		getBike,
		getBikesForCustomer,
		getCustomers,
		type Bike,
		type Customer
	} from '../../../lib/db/repositories';
	import { createWorkOrder } from '../../../lib/db/repositories/workOrders';
	import {
		cardClass,
		errorBannerClass,
		inputClass,
		labelTextClass,
		primaryButton,
		secondaryButton
	} from '../../../lib/ui';

	let customers = $state<Customer[]>([]);
	let bikes = $state<Bike[]>([]);
	let customerId = $state('');
	let bikeId = $state('');
	let issueSummary = $state('');
	let notes = $state('');
	let isLoading = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');

	onMount(async () => {
		try {
			customers = await getCustomers();

			// Arriving from a bike card preselects that bike and its owner.
			const presetBikeId = page.url.searchParams.get('bike');
			const presetBike = presetBikeId ? await getBike(presetBikeId) : null;
			customerId = presetBike?.customer_id ?? customers[0]?.id ?? '';
			await loadBikes();
			if (presetBike) bikeId = presetBike.id;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	});

	async function loadBikes() {
		bikes = customerId ? await getBikesForCustomer(customerId) : [];
		bikeId = bikes[0]?.id ?? '';
	}

	async function handleCustomerChange() {
		errorMessage = '';
		try {
			await loadBikes();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		errorMessage = '';

		if (!bikeId) {
			errorMessage = 'Choose a bike first.';
			return;
		}

		busy = true;
		try {
			const order = await createWorkOrder({
				bike_id: bikeId,
				issue_summary: issueSummary,
				notes: notes.trim() || null,
				items: []
			});
			await goto(resolve('/work-orders/[id]', { id: order.id }));
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>New work order | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-2xl p-4 sm:p-6">
		<header class="mb-6 border-b border-neutral-800 pb-6">
			<a href={resolve('/')} class="text-sm text-amber-400 hover:text-amber-300">&larr; Work orders</a>
			<h1 class="mt-2 text-3xl font-bold text-neutral-50">New work order</h1>
		</header>

		{#if errorMessage}
			<div class="mb-6 {errorBannerClass}">{errorMessage}</div>
		{/if}

		{#if isLoading}
			<p class="text-neutral-400">Loading customers...</p>
		{:else if customers.length === 0}
			<div class="{cardClass} space-y-4">
				<p class="text-neutral-300">Add a customer and a bike before opening a work order.</p>
				<a href={resolve('/customers')} class={primaryButton}>Go to customers</a>
			</div>
		{:else}
			<form class="{cardClass} space-y-5" onsubmit={handleSubmit}>
				<label class="block text-sm">
					<span class={labelTextClass}>Customer</span>
					<select class={inputClass} bind:value={customerId} onchange={handleCustomerChange}>
						{#each customers as customer (customer.id)}
							<option value={customer.id}>{customer.name}</option>
						{/each}
					</select>
				</label>

				<label class="block text-sm">
					<span class={labelTextClass}>Bike</span>
					<select class={inputClass} bind:value={bikeId} disabled={bikes.length === 0}>
						{#each bikes as bike (bike.id)}
							<option value={bike.id}>{bike.brand} {bike.model}{bike.year ? ` (${bike.year})` : ''}</option>
						{/each}
					</select>
				</label>
				{#if bikes.length === 0}
					<p class="text-sm text-neutral-400">
						This customer has no bikes yet.
						<a class="text-amber-400 underline" href={resolve('/customers')}>Register one on the customers page.</a>
					</p>
				{/if}

				<label class="block text-sm">
					<span class={labelTextClass}>Issue summary</span>
					<input
						class={inputClass}
						type="text"
						bind:value={issueSummary}
						placeholder="Shifting skips under load"
						required
					/>
				</label>

				<label class="block text-sm">
					<span class={labelTextClass}>Notes</span>
					<textarea class="{inputClass} min-h-24" bind:value={notes} placeholder="Optional"></textarea>
				</label>

				<div class="flex flex-wrap gap-3">
					<button type="submit" class={primaryButton} disabled={busy || !bikeId}>Create work order</button>
					<a href={resolve('/')} class={secondaryButton}>Cancel</a>
				</div>
			</form>
		{/if}
	</main>
</div>
