<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BikeLedger from '../../lib/components/BikeLedger.svelte';
	import {
		createBike,
		createCustomer,
		deleteBike,
		deleteCustomer,
		getBikesForCustomer,
		getCustomers,
		updateBike,
		updateCustomer,
		type Bike,
		type Customer
	} from '../../lib/db/repositories';
	import {
		cardClass,
		dangerButton,
		errorBannerClass,
		inputClass,
		labelTextClass,
		primaryButton,
		secondaryButton,
		successButton
	} from '../../lib/ui';

	const emptyCustomerForm = { name: '', phone: '', email: '', notes: '' };
	const emptyBikeForm = { brand: '', model: '', year: '', color: '', serial_number: '', notes: '' };

	let customers = $state<Customer[]>([]);
	let selectedCustomerId = $state('');
	let bikes = $state<Bike[]>([]);
	let isLoading = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');
	let customerForm = $state({ ...emptyCustomerForm });
	let bikeForm = $state({ ...emptyBikeForm });
	let editingCustomerId = $state<string | null>(null);
	let editingBikeId = $state<string | null>(null);
	let ledgerBikeId = $state<string | null>(null);

	const selectedCustomer = $derived(customers.find((customer) => customer.id === selectedCustomerId) ?? null);

	onMount(async () => {
		selectedCustomerId = page.url.searchParams.get('customer') ?? '';
		await loadCustomers();
	});

	async function loadCustomers() {
		isLoading = true;

		try {
			customers = await getCustomers();

			if (!customers.some((customer) => customer.id === selectedCustomerId)) {
				selectedCustomerId = customers[0]?.id ?? '';
			}
			await loadBikes();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	}

	async function loadBikes() {
		bikes = selectedCustomerId ? await getBikesForCustomer(selectedCustomerId) : [];
	}

	// One write at a time: the database connection is shared, so overlapping transactions would collide.
	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		errorMessage = '';
		try {
			await action();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function resetCustomerForm() {
		editingCustomerId = null;
		customerForm = { ...emptyCustomerForm };
	}

	function resetBikeForm() {
		editingBikeId = null;
		bikeForm = { ...emptyBikeForm };
	}

	function handleCustomerSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!customerForm.name.trim()) {
			errorMessage = 'Customer name is required.';
			return;
		}

		const fields = {
			name: customerForm.name,
			phone: customerForm.phone || null,
			email: customerForm.email || null,
			notes: customerForm.notes || null
		};
		const editingId = editingCustomerId;

		void run(async () => {
			const saved = editingId ? await updateCustomer(editingId, fields) : await createCustomer(fields);
			selectedCustomerId = saved.id;
			resetCustomerForm();
			await loadCustomers();
		});
	}

	function startEditCustomer(customer: Customer) {
		editingCustomerId = customer.id;
		customerForm = {
			name: customer.name,
			phone: customer.phone ?? '',
			email: customer.email ?? '',
			notes: customer.notes ?? ''
		};
	}

	function handleBikeSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!selectedCustomerId) {
			errorMessage = 'Select a customer before adding a bike.';
			return;
		}

		if (!bikeForm.brand.trim() || !bikeForm.model.trim()) {
			errorMessage = 'Bike brand and model are required.';
			return;
		}

		const year = bikeForm.year ? Number(bikeForm.year) : null;
		if (year !== null && !Number.isSafeInteger(year)) {
			errorMessage = 'Bike year must be a whole number.';
			return;
		}

		const fields = {
			brand: bikeForm.brand,
			model: bikeForm.model,
			year,
			color: bikeForm.color || null,
			serial_number: bikeForm.serial_number || null,
			notes: bikeForm.notes || null
		};
		const editingId = editingBikeId;
		const customerId = selectedCustomerId;

		void run(async () => {
			if (editingId) {
				await updateBike(editingId, fields);
			} else {
				await createBike({ customer_id: customerId, ...fields });
			}
			resetBikeForm();
			await loadBikes();
		});
	}

	function startEditBike(bike: Bike) {
		editingBikeId = bike.id;
		bikeForm = {
			brand: bike.brand,
			model: bike.model,
			year: bike.year === null ? '' : String(bike.year),
			color: bike.color ?? '',
			serial_number: bike.serial_number ?? '',
			notes: bike.notes ?? ''
		};
	}

	function handleDeleteBike(bike: Bike) {
		if (!window.confirm(`Delete ${bike.brand} ${bike.model} and its work orders and service history?`)) return;

		void run(async () => {
			await deleteBike(bike.id);
			if (editingBikeId === bike.id) resetBikeForm();
			if (ledgerBikeId === bike.id) ledgerBikeId = null;
			await loadBikes();
		});
	}

	function handleDeleteCustomer(customerId: string) {
		const target = customers.find((customer) => customer.id === customerId);
		if (!target) return;
		if (!window.confirm(`Delete ${target.name} and all associated bikes?`)) return;

		void run(async () => {
			await deleteCustomer(customerId);
			if (editingCustomerId === customerId) resetCustomerForm();
			if (selectedCustomerId === customerId) selectedCustomerId = '';
			await loadCustomers();
		});
	}

	function selectCustomer(customerId: string) {
		selectedCustomerId = customerId;
		resetBikeForm();
		ledgerBikeId = null;
		void loadBikes().catch((error: unknown) => {
			errorMessage = error instanceof Error ? error.message : String(error);
		});
	}
</script>

<svelte:head>
	<title>Customers & Bikes | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-7xl p-4 sm:p-6">
		<header class="mb-8 flex flex-col gap-4 border-b border-neutral-800 pb-6 md:flex-row md:items-end md:justify-between">
			<div>
				<p class="text-xs uppercase tracking-[0.2em] text-amber-400">Customer intake</p>
				<h1 class="mt-2 text-3xl font-bold text-neutral-50">Customers & bikes</h1>
			</div>
			<div class="rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300">
				{customers.length} customer{customers.length === 1 ? '' : 's'}
			</div>
		</header>

		{#if errorMessage}
			<div class="mb-6 {errorBannerClass}">{errorMessage}</div>
		{/if}

		<div class="grid gap-6 lg:grid-cols-[390px_minmax(0,1fr)]">
			<section class={cardClass}>
				<h2 class="mb-4 text-lg font-semibold text-neutral-100">{editingCustomerId ? 'Edit customer' : 'Add customer'}</h2>
				<form class="space-y-4" onsubmit={handleCustomerSubmit}>
					<label class="block text-sm">
						<span class={labelTextClass}>Name</span>
						<input bind:value={customerForm.name} class={inputClass} type="text" placeholder="Miguel Rios" required />
					</label>

					<div class="grid gap-4 sm:grid-cols-2">
						<label class="block text-sm">
							<span class={labelTextClass}>Phone</span>
							<input bind:value={customerForm.phone} class={inputClass} type="tel" placeholder="(555) 123-4567" />
						</label>

						<label class="block text-sm">
							<span class={labelTextClass}>Email</span>
							<input bind:value={customerForm.email} class={inputClass} type="email" placeholder="customer@example.com" />
						</label>
					</div>

					<label class="block text-sm">
						<span class={labelTextClass}>Notes</span>
						<textarea
							bind:value={customerForm.notes}
							class="{inputClass} min-h-24"
							placeholder="Service history, preferred contact method, repair notes..."
						></textarea>
					</label>

					<div class="flex gap-3">
						<button type="submit" class="{primaryButton} flex-1" disabled={busy}>
							{editingCustomerId ? 'Update customer' : 'Save customer'}
						</button>
						{#if editingCustomerId}
							<button type="button" class={secondaryButton} onclick={resetCustomerForm}>Cancel</button>
						{/if}
					</div>
				</form>

				<div class="mt-7 border-t border-neutral-800 pt-5">
					<h3 class="mb-3 text-base font-semibold text-neutral-200">Customer roster</h3>
					{#if isLoading}
						<p class="text-sm text-neutral-400">Loading customers...</p>
					{:else if customers.length === 0}
						<p class="text-sm text-neutral-400">No customers saved yet.</p>
					{:else}
						<ul class="space-y-2">
							{#each customers as customer (customer.id)}
								<li>
									<button
										type="button"
										class="min-h-14 w-full rounded-md border px-3 py-2 text-left transition {selectedCustomerId === customer.id
											? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
											: 'border-neutral-800 bg-neutral-950/60 text-neutral-200 hover:bg-neutral-800'}"
										onclick={() => selectCustomer(customer.id)}
									>
										<div class="font-medium">{customer.name}</div>
										<div class="mt-1 text-xs text-neutral-400">{customer.phone || 'No phone on file'}</div>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<section class={cardClass}>
				{#if selectedCustomer}
					<div class="mb-6 flex flex-col gap-3 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
						<div>
							<p class="text-xs uppercase tracking-[0.2em] text-amber-400">Selected customer</p>
							<h2 class="mt-2 text-2xl font-bold text-neutral-50">{selectedCustomer.name}</h2>
							<p class="mt-1 text-sm text-neutral-400">
								{[selectedCustomer.phone, selectedCustomer.email].filter(Boolean).join(' · ') || 'No contact details'}
							</p>
							{#if selectedCustomer.notes}
								<p class="mt-1 text-sm text-neutral-300">{selectedCustomer.notes}</p>
							{/if}
						</div>
						<div class="flex gap-2">
							<button type="button" class={secondaryButton} onclick={() => selectedCustomer && startEditCustomer(selectedCustomer)}>
								Edit customer
							</button>
							<button
								type="button"
								class={dangerButton}
								disabled={busy}
								onclick={() => selectedCustomer && handleDeleteCustomer(selectedCustomer.id)}
							>
								Delete customer
							</button>
						</div>
					</div>

					<div class="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
						<form class="space-y-4" onsubmit={handleBikeSubmit}>
							<h3 class="text-lg font-semibold text-neutral-100">{editingBikeId ? 'Edit bike' : 'Add bike'}</h3>

							<div class="grid gap-4 sm:grid-cols-2">
								<label class="block text-sm">
									<span class={labelTextClass}>Brand</span>
									<input bind:value={bikeForm.brand} class={inputClass} type="text" placeholder="Trek" required />
								</label>

								<label class="block text-sm">
									<span class={labelTextClass}>Model</span>
									<input bind:value={bikeForm.model} class={inputClass} type="text" placeholder="Domane AL 3" required />
								</label>
							</div>

							<div class="grid gap-4 sm:grid-cols-3">
								<label class="block text-sm">
									<span class={labelTextClass}>Year</span>
									<input bind:value={bikeForm.year} class={inputClass} type="number" inputmode="numeric" min="1900" max="2100" placeholder="2023" />
								</label>

								<label class="block text-sm">
									<span class={labelTextClass}>Color</span>
									<input bind:value={bikeForm.color} class={inputClass} type="text" placeholder="Black" />
								</label>

								<label class="block text-sm">
									<span class={labelTextClass}>Serial</span>
									<input bind:value={bikeForm.serial_number} class={inputClass} type="text" placeholder="ABC123Z" />
								</label>
							</div>

							<label class="block text-sm">
								<span class={labelTextClass}>Notes</span>
								<textarea
									bind:value={bikeForm.notes}
									class="{inputClass} min-h-20"
									placeholder="Needs front wheel truing. Owner reports clicking under load."
								></textarea>
							</label>

							<div class="flex gap-3">
								<button type="submit" class="{successButton} flex-1" disabled={busy}>
									{editingBikeId ? 'Update bike' : 'Save bike'}
								</button>
								{#if editingBikeId}
									<button type="button" class={secondaryButton} onclick={resetBikeForm}>Cancel</button>
								{/if}
							</div>
						</form>

						<div class="space-y-3">
							<h3 class="text-lg font-semibold text-neutral-100">Registered bikes</h3>
							{#if bikes.length === 0}
								<div class="rounded-lg border border-dashed border-neutral-700 bg-neutral-950/40 p-4 text-sm text-neutral-400">
									No bikes registered for {selectedCustomer.name} yet.
								</div>
							{:else}
								<div class="space-y-3">
									{#each bikes as bike (bike.id)}
										<article class="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-4">
											<div class="flex items-start justify-between gap-3">
												<div>
													<h4 class="text-lg font-semibold text-neutral-100">{bike.brand} {bike.model}</h4>
													<p class="text-xs uppercase tracking-[0.15em] text-neutral-500">{bike.year || 'Year unknown'}</p>
												</div>
												<span class="rounded-full border border-emerald-700 bg-emerald-950/40 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.15em] text-emerald-300">
													{bike.color || 'Unspecified'}
												</span>
											</div>
											<div class="space-y-1 text-sm text-neutral-300">
												{#if bike.serial_number}
													<p><span class="text-neutral-500">Serial:</span> {bike.serial_number}</p>
												{/if}
												{#if bike.notes}
													<p><span class="text-neutral-500">Notes:</span> {bike.notes}</p>
												{/if}
											</div>

											<div class="flex flex-wrap gap-2">
												<a href="{resolve('/work-orders/new')}?bike={bike.id}" class={primaryButton}>New work order</a>
												<button
													type="button"
													class={secondaryButton}
													aria-expanded={ledgerBikeId === bike.id}
													onclick={() => (ledgerBikeId = ledgerBikeId === bike.id ? null : bike.id)}
												>
													Service history
												</button>
												<button type="button" class={secondaryButton} onclick={() => startEditBike(bike)}>Edit</button>
												<button type="button" class={dangerButton} disabled={busy} onclick={() => handleDeleteBike(bike)}>Delete</button>
											</div>

											{#if ledgerBikeId === bike.id}
												<BikeLedger bikeId={bike.id} />
											{/if}
										</article>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{:else}
					<div class="rounded-lg border border-dashed border-neutral-700 bg-neutral-950/40 p-10 text-center text-neutral-400">
						Select a customer to view bike history and add a new bike.
					</div>
				{/if}
			</section>
		</div>
	</main>
</div>
