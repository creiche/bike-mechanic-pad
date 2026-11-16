<script lang="ts">
	import { onMount } from 'svelte';

	// Chromium-only event: lets us show a real Install button instead of pointing at the browser menu.
	interface InstallPromptEvent extends Event {
		prompt(): Promise<void>;
	}

	const DISMISSED_KEY = 'bmp.installHint.dismissed';

	let visible = $state(false);
	let ios = $state(false);
	let installEvent = $state<InstallPromptEvent | null>(null);

	onMount(() => {
		const standalone =
			matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
		let dismissed = false;
		try {
			dismissed = localStorage.getItem(DISMISSED_KEY) === '1';
		} catch {
			// storage blocked: show the hint, it is only a hint
		}
		if (standalone || dismissed) return;

		// iPadOS reports itself as a Mac, so touch support tells them apart.
		ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
		visible = true;

		const onPrompt = (event: Event) => {
			event.preventDefault();
			installEvent = event as InstallPromptEvent;
		};
		const onInstalled = () => (visible = false);
		window.addEventListener('beforeinstallprompt', onPrompt);
		window.addEventListener('appinstalled', onInstalled);
		return () => {
			window.removeEventListener('beforeinstallprompt', onPrompt);
			window.removeEventListener('appinstalled', onInstalled);
		};
	});

	function dismiss() {
		visible = false;
		try {
			localStorage.setItem(DISMISSED_KEY, '1');
		} catch {
			// not remembered; it shows again next time
		}
	}

	async function install() {
		await installEvent?.prompt();
		installEvent = null;
	}
</script>

{#if visible}
	<aside
		class="flex flex-wrap items-center gap-3 border-b border-amber-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-100 sm:px-6"
		data-testid="install-hint"
	>
		<p class="min-w-0 flex-1">
			<strong class="text-amber-400">Install this app before you enter shop data.</strong>
			{#if ios}
				In Safari, tap the Share button, then <strong>Add to Home Screen</strong>, and open it from there.
			{:else if installEvent}
				It then opens like a normal app and works without internet.
			{:else}
				Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.
			{/if}
			On some devices the installed app keeps its own separate storage.
		</p>
		{#if installEvent}
			<button type="button" class="min-h-12 rounded-md bg-amber-500 px-4 font-semibold text-neutral-950 hover:bg-amber-400" onclick={install}>
				Install
			</button>
		{/if}
		<button type="button" class="min-h-12 rounded-md border border-neutral-600 px-4 text-neutral-200 hover:bg-neutral-800" onclick={dismiss}>
			Not now
		</button>
	</aside>
{/if}
