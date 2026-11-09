<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BikeLedger from '../../../lib/components/BikeLedger.svelte';
	import { COMPONENT_TYPES, componentLabel, isComponentType } from '../../../lib/domain/componentTypes';
	import { centsToInput, formatCents, lineTotalCents, parseCents } from '../../../lib/domain/money';
	import { STATUS_BADGE_CLASSES, STATUS_LABELS } from '../../../lib/domain/workOrderStatus';
	import { getBike, getCustomer, type Bike, type Customer } from '../../../lib/db/repositories';
	import {
		addWorkOrderItem,
		deleteWorkOrder,
		getWorkOrder,
		removeWorkOrderItem,
		updateWorkOrder,
		updateWorkOrderItem,
		WORK_ORDER_ITEM_TYPES,
		WORK_ORDER_STATUSES,
		type WorkOrder,
		type WorkOrderItem,
		type WorkOrderItemType,
		type WorkOrderStatus
	} from '../../../lib/db/repositories/workOrders';
	import {
		filterServiceMenu,
		listServiceMenuItems,
		type ServiceMenuItem
	} from '../../../lib/db/repositories/serviceMenu';
	import {
		cardClass,
		dangerButton,
		errorBannerClass,
		inputClass,
		labelTextClass,
		primaryButton,
		secondaryButton,
		successButton
	} from '../../../lib/ui';

	const workOrderId = $derived(page.params.id ?? '');

	let order = $state<WorkOrder | null>(null);
	let bike = $state<Bike | null>(null);
	let customer = $state<Customer | null>(null);
	let isLoading = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');
	let notice = $state('');
	let ledgerVersion = $state(0);

	let details = $state({ issue_summary: '', notes: '' });
	let menuItems = $state<ServiceMenuItem[]>([]);
	let menuQuery = $state('');
	const menuMatches = $derived(filterServiceMenu(menuItems, menuQuery));
	let editingItemId = $state<string | null>(null);
	let itemForm = $state({
		item_type: 'part' as WorkOrderItemType,
		description: '',
		quantity: '1',
		price: '',
		component_type: ''
	});

	const isLocked = $derived(order?.status === 'completed' || order?.status === 'cancelled');
	const detailsDirty = $derived(
		order !== null &&
			(details.issue_summary !== order.issue_summary || details.notes !== (order.notes ?? ''))
	);
	const linePreview = $derived.by(() => {
		const quantity = Number(itemForm.quantity);
		const cents = parseCents(itemForm.price);
		if (!Number.isSafeInteger(quantity) || quantity < 1 || cents === null) return null;
		try {
			return lineTotalCents(quantity, cents);
		} catch {
			return null;
		}
	});

	// Ledger links between work orders reuse this page, so reload whenever the id in the URL changes.
	$effect(() => {
		void load(workOrderId);
	});

	async function load(id: string) {
		isLoading = true;
		errorMessage = '';
		notice = '';
		resetItemForm();
		try {
			menuItems = await listServiceMenuItems();
			const loaded = await getWorkOrder(id);
			if (id !== workOrderId) return;
			order = loaded;
			bike = null;
			customer = null;
			if (order) {
				details = { issue_summary: order.issue_summary, notes: order.notes ?? '' };
				bike = await getBike(order.bike_id);
				customer = bike ? await getCustomer(bike.customer_id) : null;
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	}

	// Leaves the Details form alone: status and line-item actions must not discard notes still being typed.
	function applyOrder(next: WorkOrder) {
		order = next;
	}

	// One write at a time: the database connection is shared, so overlapping transactions would collide.
	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		errorMessage = '';
		notice = '';
		try {
			await action();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function setStatus(status: WorkOrderStatus) {
		if (!order || order.status === status) return;
		const current = order;
		void run(async () => {
			const next = await updateWorkOrder(current.id, { status });
			applyOrder(next);
			if (status === 'completed') {
				const labels = [
					...new Set(next.items.flatMap((item) => (item.component_type ? [componentLabel(item.component_type)] : [])))
				];
				if (labels.length > 0) {
					notice = `Service ledger updated: ${labels.join(', ')}.`;
					ledgerVersion++;
				}
			}
		});
	}

	function saveDetails(event: SubmitEvent) {
		event.preventDefault();
		if (!order) return;
		const current = order;
		void run(async () => {
			const next = await updateWorkOrder(current.id, {
				issue_summary: details.issue_summary,
				notes: details.notes.trim() || null
			});
			applyOrder(next);
			details = { issue_summary: next.issue_summary, notes: next.notes ?? '' };
		});
	}

	function resetItemForm() {
		editingItemId = null;
		itemForm = { item_type: 'part', description: '', quantity: '1', price: '', component_type: '' };
	}

	function startEditItem(item: WorkOrderItem) {
		editingItemId = item.id;
		itemForm = {
			item_type: item.item_type,
			description: item.description,
			quantity: String(item.quantity),
			price: centsToInput(item.unit_price_cents),
			component_type: item.component_type ?? ''
		};
	}

	function submitItem(event: SubmitEvent) {
		event.preventDefault();
		if (!order) return;
		const current = order;

		const quantity = Number(itemForm.quantity);
		const unitPriceCents = parseCents(itemForm.price);
		if (!Number.isSafeInteger(quantity) || quantity < 1) {
			errorMessage = 'Quantity must be a whole number of 1 or more.';
			return;
		}
		if (unitPriceCents === null) {
			errorMessage = 'Enter the unit price as dollars and cents, like 45.00.';
			return;
		}

		const fields = {
			item_type: itemForm.item_type,
			description: itemForm.description,
			quantity,
			unit_price_cents: unitPriceCents,
			component_type: isComponentType(itemForm.component_type) ? itemForm.component_type : null
		};
		const itemId = editingItemId;

		void run(async () => {
			applyOrder(itemId ? await updateWorkOrderItem(itemId, fields) : await addWorkOrderItem(current.id, fields));
			resetItemForm();
		});
	}

	// Copy a menu preset onto the order as a normal line item; Edit afterwards overrides price or text.
	function quickAdd(preset: ServiceMenuItem) {
		if (!order) return;
		const current = order;
		void run(async () => {
			applyOrder(
				await addWorkOrderItem(current.id, {
					item_type: preset.item_type,
					description: preset.name,
					quantity: 1,
					unit_price_cents: preset.default_price_cents,
					component_type: preset.component_tag
				})
			);
		});
	}

	function removeItem(item: WorkOrderItem) {
		if (!window.confirm(`Remove "${item.description}" from this work order?`)) return;
		void run(async () => {
			applyOrder(await removeWorkOrderItem(item.id));
			if (editingItemId === item.id) resetItemForm();
		});
	}

	function handleDelete() {
		if (!order || !window.confirm('Delete this work order and all of its line items?')) return;
		const current = order;
		void run(async () => {
			await deleteWorkOrder(current.id);
			await goto(resolve('/'));
		});
	}
</script>

<svelte:head>
	<title>Work order | bike-mechanic-pad</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
	<main class="mx-auto max-w-7xl p-4 sm:p-6">
		<a href={resolve('/')} class="text-sm text-amber-400 hover:text-amber-300">&larr; Work orders</a>

		{#if isLoading}
			<p class="mt-6 text-neutral-400">Loading work order...</p>
		{:else if !order}
			<div class="mt-6 {cardClass}">
				<p class="text-neutral-300">This work order no longer exists.</p>
				{#if errorMessage}<p class="mt-2 text-sm text-rose-300">{errorMessage}</p>{/if}
			</div>
		{:else}
			<header class="mb-6 mt-2 flex flex-col gap-3 border-b border-neutral-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<span class="rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide {STATUS_BADGE_CLASSES[order.status]}">
						{STATUS_LABELS[order.status]}
					</span>
					<h1 class="mt-3 text-3xl font-bold text-neutral-50">
						{#if customer}
							<a class="hover:text-amber-300" href="{resolve('/customers')}?customer={customer.id}">{customer.name}</a>
						{:else}
							Customer
						{/if}
					</h1>
					{#if bike}
						<p class="text-lg text-neutral-300">{bike.brand} {bike.model}{bike.year ? ` (${bike.year})` : ''}</p>
					{/if}
				</div>
				<div class="text-left sm:text-right">
					<p class="text-sm text-neutral-400">Total</p>
					<p class="text-4xl font-bold text-amber-400">{formatCents(order.total_cents)}</p>
				</div>
			</header>

			{#if errorMessage}
				<div class="mb-6 {errorBannerClass}">{errorMessage}</div>
			{/if}
			{#if notice}
				<div class="mb-6 rounded-md border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200" role="status">
					{notice}
				</div>
			{/if}

			<section class="mb-6 {cardClass}" aria-label="Status">
				<h2 class="mb-3 text-lg font-semibold">Status</h2>
				<div class="flex flex-wrap gap-2" role="group" aria-label="Set status">
					{#each WORK_ORDER_STATUSES as status (status)}
						<button
							type="button"
							aria-pressed={order.status === status}
							disabled={busy}
							class="min-h-12 rounded-md border px-4 text-base font-medium transition disabled:opacity-50 {order.status === status
								? STATUS_BADGE_CLASSES[status] + ' ring-2 ring-amber-500'
								: 'border-neutral-700 bg-neutral-950 text-neutral-200 hover:bg-neutral-800'}"
							onclick={() => setStatus(status)}
						>
							{STATUS_LABELS[status]}
						</button>
					{/each}
				</div>
				<p class="mt-3 text-sm text-neutral-400">
					Completing a work order stamps today's date and this work order on every component its line items are tagged with.
				</p>
			</section>

			<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
				<div class="space-y-6">
					<section class={cardClass} aria-label="Line items">
						<h2 class="mb-4 text-lg font-semibold">Line items</h2>

						{#if order.items.length === 0}
							<p class="mb-4 rounded-lg border border-dashed border-neutral-700 bg-neutral-950/40 p-4 text-sm text-neutral-400">
								No line items yet.
							</p>
						{:else}
							<ul class="mb-4 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-950/60">
								{#each order.items as item (item.id)}
									<li class="flex flex-wrap items-center justify-between gap-3 p-3 {editingItemId === item.id ? 'bg-amber-500/10' : ''}">
										<div class="min-w-0 flex-1">
											<p class="text-base font-medium text-neutral-100">{item.description}</p>
											<p class="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-400">
												<span class="rounded border border-neutral-700 px-2 py-0.5 text-xs uppercase tracking-wide">{item.item_type}</span>
												{#if item.component_type}
													<span class="rounded border border-amber-700 bg-amber-950/40 px-2 py-0.5 text-xs text-amber-200">
														{componentLabel(item.component_type)}
													</span>
												{/if}
												{item.quantity} &times; {formatCents(item.unit_price_cents)}
											</p>
										</div>
										<p class="text-lg font-semibold text-neutral-100">{formatCents(lineTotalCents(item.quantity, item.unit_price_cents))}</p>
										<div class="flex gap-2">
											<button type="button" class={secondaryButton} disabled={busy || isLocked} onclick={() => startEditItem(item)}>
												Edit
											</button>
											<button
												type="button"
												class={dangerButton}
												disabled={busy || isLocked}
												aria-label="Remove {item.description}"
												onclick={() => removeItem(item)}
											>
												Remove
											</button>
										</div>
									</li>
								{/each}
							</ul>
						{/if}

						{#if isLocked}
							<p class="text-sm text-neutral-400">
								This work order is {STATUS_LABELS[order.status].toLowerCase()}. Set it back to open or in progress to change line items.
							</p>
						{:else}
							<div class="mb-4 space-y-3 border-t border-neutral-800 pt-4" aria-label="Quick add from service menu">
								<h3 class="text-base font-semibold text-neutral-200">Quick add from service menu</h3>
								<input class={inputClass} type="search" bind:value={menuQuery} placeholder="Search services..." aria-label="Search service menu" />
								<ul class="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
									{#each menuMatches as preset (preset.id)}
										<li>
											<button
												type="button"
												class="{secondaryButton} w-full justify-between gap-3 text-left"
												disabled={busy}
												onclick={() => quickAdd(preset)}
											>
												<span>{preset.name}</span>
												<span class="text-amber-300">{formatCents(preset.default_price_cents)}</span>
											</button>
										</li>
									{:else}
										<li class="text-sm text-neutral-400">No matching services.</li>
									{/each}
								</ul>
							</div>

							<form class="space-y-4 border-t border-neutral-800 pt-4" onsubmit={submitItem}>
								<h3 class="text-base font-semibold text-neutral-200">{editingItemId ? 'Edit line item' : 'Add line item'}</h3>

								<div class="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
									<label class="block text-sm">
										<span class={labelTextClass}>Type</span>
										<select class={inputClass} bind:value={itemForm.item_type}>
											{#each WORK_ORDER_ITEM_TYPES as type (type)}
												<option value={type}>{type === 'labor' ? 'Labor' : 'Part'}</option>
											{/each}
										</select>
									</label>
									<label class="block text-sm">
										<span class={labelTextClass}>Description</span>
										<input class={inputClass} type="text" bind:value={itemForm.description} placeholder="11-speed chain" required />
									</label>
								</div>

								<div class="grid gap-4 sm:grid-cols-3">
									<label class="block text-sm">
										<span class={labelTextClass}>Quantity</span>
										<input class={inputClass} type="number" inputmode="numeric" min="1" step="1" bind:value={itemForm.quantity} required />
									</label>
									<label class="block text-sm">
										<span class={labelTextClass}>Unit price ($)</span>
										<input class={inputClass} type="text" inputmode="decimal" bind:value={itemForm.price} placeholder="45.00" required />
									</label>
									<label class="block text-sm">
										<span class={labelTextClass}>Component serviced</span>
										<select class={inputClass} bind:value={itemForm.component_type}>
											<option value="">None</option>
											{#each COMPONENT_TYPES as type (type.value)}
												<option value={type.value}>{type.label}</option>
											{/each}
										</select>
									</label>
								</div>

								<div class="flex flex-wrap items-center gap-3">
									<button type="submit" class={successButton} disabled={busy}>
										{editingItemId ? 'Update item' : 'Add item'}
									</button>
									{#if editingItemId}
										<button type="button" class={secondaryButton} onclick={resetItemForm}>Cancel edit</button>
									{/if}
									{#if linePreview !== null}
										<span class="text-sm text-neutral-400">Line total {formatCents(linePreview)}</span>
									{/if}
								</div>
							</form>
						{/if}
					</section>

					<section class={cardClass} aria-label="Details">
						<h2 class="mb-4 text-lg font-semibold">Details</h2>
						<form class="space-y-4" onsubmit={saveDetails}>
							<label class="block text-sm">
								<span class={labelTextClass}>Issue summary</span>
								<input class={inputClass} type="text" bind:value={details.issue_summary} required />
							</label>
							<label class="block text-sm">
								<span class={labelTextClass}>Notes</span>
								<textarea class="{inputClass} min-h-24" bind:value={details.notes}></textarea>
							</label>
							<button type="submit" class={primaryButton} disabled={busy || !detailsDirty}>Save details</button>
						</form>
					</section>
				</div>

				<aside class="space-y-6">
					<section class={cardClass} aria-label="Bike service history">
						<h2 class="mb-4 text-lg font-semibold">Bike service history</h2>
						{#if bike}
							{#key ledgerVersion}
								<BikeLedger bikeId={bike.id} />
							{/key}
						{/if}
					</section>

					<button type="button" class="{dangerButton} w-full" disabled={busy} onclick={handleDelete}>Delete work order</button>
				</aside>
			</div>
		{/if}
	</main>
</div>
