<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import StorageStatus from '../lib/components/StorageStatus.svelte';
	import SyncStatusPill from '../lib/components/SyncStatusPill.svelte';
	import { syncService } from '../lib/sync/runtime';
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Runs before any child, so screens read loaded sync settings on first render. The app is client-only (ssr = false).
	syncService.init();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-x-4 border-b border-neutral-800 bg-workshop-dark px-4 py-2 sm:px-6">
	<nav class="flex flex-wrap items-center gap-1 text-base font-medium text-neutral-300 sm:gap-2">
		<a href={resolve('/')} class="flex min-h-12 items-center rounded-md px-3 font-bold text-amber-500 hover:text-amber-400">bike-mechanic-pad</a>
		<a href={resolve('/')} class="flex min-h-12 items-center rounded-md px-3 hover:bg-neutral-800 hover:text-white">Work orders</a>
		<a href={resolve('/customers')} class="flex min-h-12 items-center rounded-md px-3 hover:bg-neutral-800 hover:text-white">Customers</a>
		<a href={resolve('/settings')} class="flex min-h-12 items-center rounded-md px-3 hover:bg-neutral-800 hover:text-white">Settings</a>
	</nav>
	<div class="flex items-center gap-4">
		<StorageStatus />
		<a href={resolve('/settings')} aria-label="Sync settings"><SyncStatusPill /></a>
	</div>
</header>

{@render children()}
