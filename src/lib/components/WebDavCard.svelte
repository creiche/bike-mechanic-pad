<script lang="ts">
	import { explainWebDavFailure } from '../sync/display';
	import { syncService } from '../sync/runtime';
	import { DEFAULT_FOLDER_PATH } from '../sync/settings';
	import { dangerButton, errorBannerClass, inputClass, primaryButton, secondaryButton } from '../ui';

	const saved = syncService.getSettings();

	let webdavUrl = $state(saved.webdavUrl);
	let username = $state(saved.username);
	let password = $state(saved.password);
	let folderPath = $state(saved.folderPath || DEFAULT_FOLDER_PATH);
	let busy = $state(false);
	let errorMessage = $state('');
	let notice = $state('');

	const appOrigin = location.origin;
	let hasSavedPassword = $state(Boolean(saved.webdavUrl && saved.password));
	const details = () => ({ webdavUrl, username, password, folderPath });

	async function run(action: () => Promise<void>) {
		busy = true;
		errorMessage = '';
		notice = '';
		try {
			await action();
		} catch (error) {
			errorMessage = explainWebDavFailure(error, appOrigin);
		} finally {
			busy = false;
		}
	}

	function handleSave(event: SubmitEvent) {
		event.preventDefault();
		void run(async () => {
			await syncService.saveWebDav(details());
			({ webdavUrl, username, password, folderPath } = syncService.getSettings());
			hasSavedPassword = true;
			notice = 'WebDAV saved. Syncing has started.';
		});
	}

	function handleTest() {
		if (!webdavUrl.trim() || !username.trim() || !password) {
			errorMessage = 'Enter the address, username and password first.';
			notice = '';
			return;
		}
		void run(async () => {
			await syncService.testWebDav(details());
			notice = 'Connection works.';
		});
	}

	function handleDisconnect() {
		if (!confirm('Disconnect WebDAV? Data on this device is kept, and this device forgets the password.')) return;
		void run(async () => {
			syncService.disconnectWebDav();
			password = '';
			hasSavedPassword = false;
			notice = 'WebDAV disconnected.';
		});
	}
</script>

<form class="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6" aria-labelledby="webdav-heading" onsubmit={handleSave}>
	<h2 id="webdav-heading" class="text-lg font-medium text-neutral-200">WebDAV server</h2>
	<p class="text-sm text-neutral-400">Optional. Sync through your own server (Nextcloud, a NAS) when devices are not together.</p>

	{#if errorMessage}
		<p role="alert" class={errorBannerClass}>{errorMessage}</p>
	{/if}
	{#if notice}
		<p role="status" class="rounded border border-emerald-900/50 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>
	{/if}

	<div class="space-y-1">
		<label for="webdav-url" class="text-sm text-neutral-300">WebDAV address</label>
		<input id="webdav-url" class={inputClass} type="url" bind:value={webdavUrl} required placeholder="https://cloud.example.com/remote.php/dav/files/you" autocomplete="off" autocapitalize="off" spellcheck="false" />
	</div>

	<div class="space-y-1">
		<label for="webdav-username" class="text-sm text-neutral-300">Username</label>
		<input id="webdav-username" class={inputClass} bind:value={username} required autocomplete="username" autocapitalize="off" spellcheck="false" />
	</div>

	<div class="space-y-1">
		<label for="webdav-password" class="text-sm text-neutral-300">Password</label>
		<input id="webdav-password" class={inputClass} type="password" bind:value={password} required autocomplete="current-password" />
		<p class="text-xs text-neutral-500">Stored unencrypted in this browser, so use an app password rather than your main one where the server offers it.</p>
	</div>

	<div class="space-y-1">
		<label for="folder-path" class="text-sm text-neutral-300">Sync folder</label>
		<input id="folder-path" class={inputClass} bind:value={folderPath} placeholder={DEFAULT_FOLDER_PATH} autocomplete="off" autocapitalize="off" spellcheck="false" />
		<p class="text-xs text-neutral-500">Use the same folder on every device. Changing it after syncing starts a fresh folder holding only about the last 30 days of this device's changes, so a device set up on it later will be missing older records. Only do that on purpose.</p>
	</div>

	<div class="flex flex-wrap gap-3">
		<button type="submit" class={primaryButton} disabled={busy}>Save &amp; Connect</button>
		<button type="button" class={secondaryButton} disabled={busy} onclick={handleTest}>Test Connection</button>
		{#if hasSavedPassword}
			<button type="button" class={dangerButton} disabled={busy} onclick={handleDisconnect}>Disconnect</button>
		{/if}
	</div>

	<details class="text-sm text-neutral-400">
		<summary class="min-h-12 cursor-pointer py-3 text-neutral-300">Server setup</summary>
		<div class="space-y-2">
			<p>The server needs an https:// address and must allow this app through CORS:</p>
			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs">
				<dt>Origin</dt>
				<dd class="break-all">{appOrigin}</dd>
				<dt>Methods</dt>
				<dd class="break-all">OPTIONS, GET, PUT, MKCOL, PROPFIND</dd>
				<dt>Headers</dt>
				<dd class="break-all">Authorization, Content-Type, Depth, If-None-Match</dd>
			</dl>
		</div>
	</details>
</form>
