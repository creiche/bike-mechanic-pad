<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createBike,
		createCustomer,
		deleteCustomer,
		getBikesForCustomer,
		getCustomers,
		type Bike,
		type Customer
	} from '../../lib/db/repositories';

	let customers = $state<Customer[]>([]);
	let selectedCustomerId = $state('');
	let selectedCustomer = $state<Customer | null>(null);
	let bikes = $state<Bike[]>([]);
	let isLoading = $state(true);
	let errorMessage = $state('');
	let customerForm = $state({
		name: '',
		phone: '',
		email: '',
		notes: ''
	});
	let bikeForm = $state({
		brand: '',
		model: '',
		year: '',
		color: '',
		serial_number: '',
		notes: ''
	});

	onMount(async () => {
		await loadCustomers();
	});

	async function loadCustomers() {
		isLoading = true;
		errorMessage = '';

		try {
			customers = await getCustomers();

			if (customers.length === 0) {
				selectedCustomerId = '';
				selectedCustomer = null;
				bikes = [];
				return;
			}

			if (!selectedCustomerId || !customers.some((customer) => customer.id === selectedCustomerId)) {
				selectedCustomerId = customers[0].id;
			}

			selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) ?? null;
			await loadBikes();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	}

	async function loadBikes() {
		if (!selectedCustomerId) {
			bikes = [];
			selectedCustomer = null;
			return;
		}

		bikes = await getBikesForCustomer(selectedCustomerId);
		selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) ?? null;
	}

	async function handleCustomerSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!customerForm.name.trim()) {
			errorMessage = 'Customer name is required.';
			return;
		}

		try {
			const newCustomer = await createCustomer({
				name: customerForm.name,
				phone: customerForm.phone || null,
				email: customerForm.email || null,
				notes: customerForm.notes || null
			});

			customerForm = { name: '', phone: '', email: '', notes: '' };
			selectedCustomerId = newCustomer.id;
			await loadCustomers();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	async function handleBikeSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = '';
		if (!selectedCustomerId) {
			errorMessage = 'Select a customer before adding a bike.';
			return;
		}

		if (!bikeForm.brand.trim() || !bikeForm.model.trim()) {
			errorMessage = 'Bike brand and model are required.';
			return;
		}

		try {
			await createBike({
				customer_id: selectedCustomerId,
				brand: bikeForm.brand,
				model: bikeForm.model,
				year: bikeForm.year ? Number(bikeForm.year) : null,
				color: bikeForm.color || null,
				serial_number: bikeForm.serial_number || null,
				notes: bikeForm.notes || null
			});

			bikeForm = { brand: '', model: '', year: '', color: '', serial_number: '', notes: '' };
			await loadBikes();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	async function handleDeleteCustomer(customerId: string) {
		const target = customers.find((customer) => customer.id === customerId);
		if (!target) {
			return;
		}

		const confirmed = window.confirm(`Delete ${target.name} and all associated bikes?`);
		if (!confirmed) {
			return;
		}

		errorMessage = '';
		try {
			await deleteCustomer(customerId);
			if (selectedCustomerId === customerId) {
				selectedCustomerId = '';
				selectedCustomer = null;
				bikes = [];
			}
			await loadCustomers();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	function selectCustomer(customerId: string) {
		selectedCustomerId = customerId;
		selectedCustomer = customers.find((customer) => customer.id === customerId) ?? null;
		void loadBikes();
	}
</script>

<svelte:head>
	<title>Customers & Bikes | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-7xl p-6">
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
			<div class="mb-6 rounded-md border border-rose-800 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
				{errorMessage}
			</div>
		{/if}

		<div class="grid gap-6 lg:grid-cols-[390px_minmax(0,1fr)]">
			<section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-lg shadow-black/20">
				<h2 class="mb-4 text-lg font-semibold text-neutral-100">Add customer</h2>
				<form class="space-y-4" onsubmit={handleCustomerSubmit}>
					<label class="block text-sm">
						<span class="mb-1.5 block text-neutral-300">Name</span>
						<input
							bind:value={customerForm.name}
							class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
							type="text"
							placeholder="Miguel Rios"
							required
						/>
					</label>

					<div class="grid gap-4 sm:grid-cols-2">
						<label class="block text-sm">
							<span class="mb-1.5 block text-neutral-300">Phone</span>
							<input
								bind:value={customerForm.phone}
								class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
								type="tel"
								placeholder="(555) 123-4567"
							/>
						</label>

						<label class="block text-sm">
							<span class="mb-1.5 block text-neutral-300">Email</span>
							<input
								bind:value={customerForm.email}
								class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
								type="email"
								placeholder="customer@example.com"
							/>
						</label>
					</div>

					<label class="block text-sm">
						<span class="mb-1.5 block text-neutral-300">Notes</span>
						<textarea
							bind:value={customerForm.notes}
							class="min-h-24 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
							placeholder="Service history, preferred contact method, repair notes..."
						></textarea>
					</label>

					<button
						type="submit"
						class="w-full rounded-md bg-amber-500 px-4 py-2.5 font-semibold text-neutral-950 transition hover:bg-amber-400"
					>
						Save customer
					</button>
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
								<li class="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 p-2">
									<button
										type="button"
										class="flex-1 rounded-md px-2 py-2 text-left transition {selectedCustomerId === customer.id ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/50' : 'text-neutral-200 hover:bg-neutral-800'}"
										onclick={() => selectCustomer(customer.id)}
									>
										<div class="font-medium">{customer.name}</div>
										<div class="mt-1 text-xs text-neutral-400">{customer.phone || 'No phone on file'}</div>
									</button>
									<button
										type="button"
										class="rounded-md border border-rose-800 bg-rose-950/30 px-2 py-1.5 text-xs font-medium text-rose-200 transition hover:border-rose-700 hover:bg-rose-900/40"
										onclick={() => handleDeleteCustomer(customer.id)}
									>
										Delete
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-lg shadow-black/20">
				{#if selectedCustomer}
					<div class="mb-6 flex flex-col gap-3 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
						<div>
							<p class="text-xs uppercase tracking-[0.2em] text-amber-400">Selected customer</p>
							<h2 class="mt-2 text-2xl font-bold text-neutral-50">{selectedCustomer.name}</h2>
						</div>
						<button
							type="button"
							class="rounded-md border border-rose-700 bg-rose-950/30 px-3 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-900/40"
							onclick={() => {
								if (selectedCustomer) {
									handleDeleteCustomer(selectedCustomer.id);
								}
							}}
						>
							Delete customer
						</button>
					</div>

					<div class="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
						<form class="space-y-4" onsubmit={handleBikeSubmit}>
							<h3 class="text-lg font-semibold text-neutral-100">Add bike</h3>

							<div class="grid gap-4 sm:grid-cols-2">
								<label class="block text-sm">
									<span class="mb-1.5 block text-neutral-300">Brand</span>
									<input
										bind:value={bikeForm.brand}
										class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
										type="text"
										placeholder="Trek"
										required
									/>
								</label>

								<label class="block text-sm">
									<span class="mb-1.5 block text-neutral-300">Model</span>
									<input
										bind:value={bikeForm.model}
										class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
										type="text"
										placeholder="Domane AL 3"
										required
									/>
								</label>
							</div>

							<div class="grid gap-4 sm:grid-cols-3">
								<label class="block text-sm">
									<span class="mb-1.5 block text-neutral-300">Year</span>
									<input
										bind:value={bikeForm.year}
										class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
										type="number"
										min="1900"
										max="2100"
										placeholder="2023"
									/>
								</label>

								<label class="block text-sm">
									<span class="mb-1.5 block text-neutral-300">Color</span>
									<input
										bind:value={bikeForm.color}
										class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
										type="text"
										placeholder="Black"
									/>
								</label>

								<label class="block text-sm">
									<span class="mb-1.5 block text-neutral-300">Serial</span>
									<input
										bind:value={bikeForm.serial_number}
										class="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
										type="text"
										placeholder="ABC123Z"
									/>
								</label>
							</div>

							<label class="block text-sm">
								<span class="mb-1.5 block text-neutral-300">Notes</span>
								<textarea
									bind:value={bikeForm.notes}
									class="min-h-20 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none transition focus:border-amber-500"
									placeholder="Needs front wheel truing. Owner reports clicking under load."
								></textarea>
							</label>

							<button
								type="submit"
								class="w-full rounded-md bg-emerald-500 px-4 py-2.5 font-semibold text-neutral-950 transition hover:bg-emerald-400"
							>
								Save bike
							</button>
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
										<article class="rounded-lg border border-neutral-800 bg-neutral-950/60 p-4">
											<div class="mb-2 flex items-start justify-between gap-3">
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
