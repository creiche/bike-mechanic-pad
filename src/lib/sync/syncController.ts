import { resetPullCursors } from '../db/repositories/sync';
import { DropboxAdapter } from './cloud/dropbox';
import { DropboxAuth, type KeyValueStorage } from './cloud/dropboxAuth';
import type { FetchLike } from './cloud/http';
import { loadDeviceIdentity, saveDeviceName, type DeviceIdentity } from './device';
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from './settings';
import { LOCK_NAME, SyncService, type SyncState } from './syncService';

// 'unconfigured' = no app key yet; 'disconnected' = app key saved but Dropbox not authorized.
export type ConnectionStatus = 'unconfigured' | 'disconnected' | 'connected';

export interface SyncControllerState extends SyncState {
	connection: ConnectionStatus;
}

export interface SyncControllerOptions {
	// Must match the redirect URI registered in the Dropbox app console.
	redirectUri: () => string;
	storage?: KeyValueStorage;
	sessionStorage?: KeyValueStorage;
	fetch?: FetchLike;
	// Test seam; defaults to the real repository.
	resetPullCursors?: () => Promise<void>;
}

export interface SyncSettingsInput extends SyncSettings {
	deviceName: string;
}

const IDLE: SyncState = { status: 'idle', lastSyncedAt: null, lastSummary: null, error: null };

// Owns the configured SyncService and the Dropbox auth behind it. Settings changes rebuild the service, so UI code
// subscribes to this one stable store (`$syncService`) instead of a service instance that gets replaced.
export class SyncController {
	private state: SyncControllerState = { ...IDLE, connection: 'unconfigured' };
	private readonly listeners = new Set<(state: SyncControllerState) => void>();
	private auth: DropboxAuth | null = null;
	private service: SyncService | null = null;
	private detachService: (() => void) | null = null;
	private settings: SyncSettings = { appKey: '', folderPath: '' };
	private identity: DeviceIdentity | null = null;

	constructor(private readonly options: SyncControllerOptions) {}

	getState(): SyncControllerState {
		return this.state;
	}

	subscribe(listener: (state: SyncControllerState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	getSettings(): SyncSettings {
		return this.settings;
	}

	getIdentity(): DeviceIdentity {
		return (this.identity ??= loadDeviceIdentity(this.options.storage ?? localStorage));
	}

	// Load saved settings and start background sync if Dropbox is already authorized.
	init(): void {
		this.settings = loadSyncSettings(this.options.storage ?? localStorage);
		this.rebuild();
	}

	async saveSettings(input: SyncSettingsInput): Promise<void> {
		const storage = this.options.storage ?? localStorage;
		if (!input.deviceName.trim()) throw new Error('Device name is required.'); // validate everything before writing anything
		const next = saveSyncSettings(input, storage);
		saveDeviceName(input.deviceName, storage);
		this.identity = null;

		// Tokens belong to one Dropbox app; they are useless (and a refresh would fail) under another key.
		if (next.appKey !== this.settings.appKey) await this.auth?.disconnect();
		// First-time setup has no earlier folder whose cursors could be stale.
		const relayChanged =
			this.settings.appKey !== '' &&
			(next.appKey !== this.settings.appKey || next.folderPath !== this.settings.folderPath);
		this.settings = next;
		this.service?.stop();
		try {
			if (relayChanged) {
				// Pull cursors belong to the old folder's packets. Wait for a running cycle (same lock as sync, restore and
				// clear) so it cannot write an old-folder cursor after the reset.
				const locks = globalThis.navigator?.locks;
				const reset = this.options.resetPullCursors ?? resetPullCursors;
				await (locks ? locks.request(LOCK_NAME, reset) : reset());
			}
		} finally {
			this.rebuild(); // always restart sync, even if the reset failed (the error still reaches the caller)
		}
	}

	// Step 1 of sign-in: returns the Dropbox URL the page should navigate to.
	async beginAuthorization(): Promise<string> {
		if (!this.auth) throw new Error('Save a Dropbox app key first.');
		return this.auth.createAuthorizationUrl();
	}

	// Step 2: call with the URL Dropbox redirected back to. Throws CloudError('auth') when denied or invalid.
	async completeAuthorization(callbackUrl: string | URL): Promise<void> {
		if (!this.auth) throw new Error('Save a Dropbox app key first.');
		await this.auth.completeAuthorization(callbackUrl);
		this.rebuild();
	}

	async disconnect(): Promise<void> {
		await this.auth?.disconnect();
		this.rebuild();
	}

	syncNow(): Promise<SyncControllerState> {
		return this.service ? this.service.syncNow().then(() => this.state) : Promise.resolve(this.state);
	}

	// Call after a local write; a no-op until Dropbox is connected. Offline, the outbox keeps the change and the
	// service's 'online' listener syncs on reconnect, so no doomed request is made.
	requestSync(): void {
		if (globalThis.navigator?.onLine === false) return;
		this.service?.requestSync();
	}

	private rebuild(): void {
		this.detachService?.();
		this.service?.stop();
		this.detachService = this.service = this.auth = null;

		if (!this.settings.appKey) {
			this.setState({ ...IDLE }, 'unconfigured');
			return;
		}

		const { storage, sessionStorage, fetch } = this.options;
		this.auth = new DropboxAuth({
			appKey: this.settings.appKey,
			redirectUri: this.options.redirectUri(),
			storage,
			sessionStorage,
			fetch
		});

		if (!this.auth.isConnected()) {
			this.setState({ ...IDLE }, 'disconnected');
			return;
		}

		const service = new SyncService({
			adapter: new DropboxAdapter(this.auth, { fetch }),
			identity: this.getIdentity(),
			folderPath: this.settings.folderPath
		});
		this.service = service;
		this.detachService = service.subscribe((syncState) => {
			const connected = this.auth?.isConnected() ?? false;
			this.setState(syncState, connected ? 'connected' : 'disconnected');
			// Token refresh was rejected: stop hammering Dropbox; the error stays visible until the user reconnects.
			if (!connected) service.stop();
		});
		service.start();
	}

	private setState(sync: SyncState, connection: ConnectionStatus): void {
		this.state = { ...sync, connection };
		for (const listener of this.listeners) listener(this.state);
	}
}
