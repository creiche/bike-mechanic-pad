<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import SyncStatusPill from '../lib/components/SyncStatusPill.svelte';
	import { syncService } from '../lib/sync/runtime';
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Runs before any child, so the settings page can finish an OAuth redirect on first render. The app is client-only (ssr = false).
	syncService.init();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-neutral-800 bg-workshop-dark px-6 py-3">
	<nav class="flex items-center gap-5 text-sm font-medium text-neutral-300">
		<a href={resolve('/')} class="font-bold text-amber-500 hover:text-amber-400">bike-mechanic-pad</a>
		<a href={resolve('/customers')} class="hover:text-white">Customers</a>
		<a href={resolve('/settings')} class="hover:text-white">Settings</a>
	</nav>
	<a href={resolve('/settings')} aria-label="Sync settings"><SyncStatusPill /></a>
</header>

{@render children()}
