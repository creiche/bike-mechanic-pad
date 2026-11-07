<script lang="ts">
  import { onMount } from 'svelte';
  import { openDatabase } from '../lib/db/client';

  let dbStatus = $state('Initializing SQLite WASM & OPFS...');
  let isConnected = $state(false);
  let errorMessage = $state('');

  onMount(async () => {
    try {
      await openDatabase();
      isConnected = true;
      dbStatus = 'SQLite OPFS Connected Successfully (Local)';
    } catch (err: unknown) {
      isConnected = false;
      dbStatus = 'Failed to initialize database';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<main class="min-h-screen bg-neutral-950 text-neutral-100 p-8 flex flex-col justify-between">
  <div class="max-w-xl mx-auto w-full space-y-6">
    <header class="border-b border-neutral-800 pb-4">
      <h1 class="text-2xl font-bold tracking-tight text-amber-500">bike-mechanic-pad</h1>
      <p class="text-sm text-neutral-400">Local-First Digital Clipboard for Solo Mechanics</p>
    </header>

    <section class="bg-neutral-900 border border-neutral-800 rounded-lg p-6 space-y-4">
      <h2 class="text-lg font-medium text-neutral-200">System Diagnostic Status</h2>
      
      <div class="flex items-center space-x-3 p-3 rounded-md bg-neutral-950 border border-neutral-800">
        <span class="w-3 h-3 rounded-full {isConnected ? 'bg-emerald-500 animate-pulse' : errorMessage ? 'bg-rose-500' : 'bg-amber-500 animate-ping'}"></span>
        <span class="text-sm font-mono">{dbStatus}</span>
      </div>

      {#if errorMessage}
        <p class="text-xs text-rose-400 font-mono bg-rose-950/30 p-3 rounded border border-rose-900/50">
          {errorMessage}
        </p>
      {/if}
    </section>
  </div>

  <footer class="text-center text-xs text-neutral-600 border-t border-neutral-900 pt-4">
    GPLv3 Open Source &bull; Offline-First SQLite WASM Architecture
  </footer>
</main>