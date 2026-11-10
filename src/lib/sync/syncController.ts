import { resetPullCursors, type PeerTrustRepository, type SyncRepository } from '../db/repositories/sync';
import type { FetchLike } from './cloud/http';
import { WebDavTransport } from './cloud/webdav';
import { loadDeviceIdentity, saveDeviceName, type DeviceIdentity } from './device';
import { NearbySession, type NearbyPairingApi, type NearbyPeer, type NearbyState } from './p2p/nearbySession';
import { ScreenWake } from './screenWake';
import { loadSyncSettings, normalizeFolderPath, saveSyncSettings, type KeyValueStorage, type SyncSettings } from './settings';
import { LOCK_NAME, SyncService, type SyncCycleSummary, type SyncState } from './syncService';
import type { PeerTransport } from './transport';

// 'unconfigured' = nothing set up; 'disconnected' = WebDAV details incomplete or rejected; 'connected' = something can sync.
export type ConnectionStatus = 'unconfigured' | 'disconnected' | 'connected';

export interface SyncControllerState extends SyncState {
	connection: ConnectionStatus;
	nearby: NearbyState;
	peers: NearbyPeer[];
}

export interface SyncControllerOptions {
	storage?: KeyValueStorage;
	fetch?: FetchLike;
	// Test seams; default to the real repository and real WebRTC.
	resetPullCursors?: () => Promise<void>;
	repository?: SyncRepository;
	pairing?: NearbyPairingApi;
	trust?: PeerTrustRepository;
}

interface PeerSync {
	service: SyncService;
	detach: () => void;
	state: SyncState;
}

const IDLE: SyncState = { status: 'idle', lastSyncedAt: null, lastSummary: null, error: null };
const OLD_DROPBOX_TOKENS_KEY = 'bmp.sync.dropbox.tokens';

function combinedStatus(states: SyncState[]): SyncState['status'] {
	for (const status of ['syncing', 'error', 'offline'] as const) {
		if (states.some((state) => state.status === status)) return status;
	}
	return 'idle';
}

// Owns the sync paths: a long-lived WebDAV service, rebuilt when its settings change, and one service per nearby-device
// link, each living as long as its link. UI code subscribes to this one stable store (`$syncService`) and sees them merged.
export class SyncController {
	readonly nearby: NearbySession;
	private state: SyncControllerState;
	private readonly listeners = new Set<(state: SyncControllerState) => void>();
	private settings: SyncSettings = loadSyncSettings({ getItem: () => null, setItem: () => {} });
	private identity: DeviceIdentity | null = null;

	private relay: SyncService | null = null;
	private detachRelay: (() => void) | null = null;
	private relayState: SyncState = IDLE;
	private relayConnection: ConnectionStatus = 'unconfigured';

	private readonly peerSyncs = new Map<string, PeerSync>();
	private readonly screenWake = new ScreenWake();

	private lastSyncedAt: string | null = null;
	private lastSummary: SyncCycleSummary | null = null;
	private readonly droppedByService = new Map<SyncService, number>();

	constructor(private readonly options: SyncControllerOptions = {}) {
		this.nearby = new NearbySession({
			identity: () => this.getIdentity(),
			onChange: () => this.publish(),
			onConnected: (transport) => this.startPeer(transport),
			onEnded: (deviceId) => this.stopPeer(deviceId),
			pairing: options.pairing,
			trust: options.trust
		});
		this.state = { ...IDLE, connection: 'unconfigured', nearby: this.nearby.getState(), peers: [] };
	}

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
		return (this.identity ??= loadDeviceIdentity(this.storage));
	}

	// Load saved settings and start background sync if WebDAV is set up.
	init(): void {
		this.storage.removeItem(OLD_DROPBOX_TOKENS_KEY); // a refresh token must not outlive the feature that used it
		this.settings = loadSyncSettings(this.storage);
		this.rebuildRelay();
		void this.nearby.loadTrusted();
	}

	saveDeviceName(deviceName: string): void {
		saveDeviceName(deviceName, this.storage);
		this.identity = null;
		this.rebuildRelay(); // packets carry the device name
	}

	async saveWebDav(input: SyncSettings): Promise<void> {
		const next = saveSyncSettings(input, this.storage);
		const previous = this.settings;
		// First-time setup has no earlier folder whose cursors could be stale. A new password is the same folder.
		const relayChanged =
			previous.webdavUrl !== '' &&
			(next.webdavUrl !== previous.webdavUrl || next.username !== previous.username || next.folderPath !== previous.folderPath);
		this.settings = next;
		this.relay?.stop();
		try {
			if (relayChanged) {
				// Pull cursors belong to the old folder's packets. Wait for a running cycle (same lock as sync, restore and
				// clear) so it cannot write an old-folder cursor after the reset.
				const locks = globalThis.navigator?.locks;
				const reset = this.options.resetPullCursors ?? resetPullCursors;
				await (locks ? locks.request(LOCK_NAME, reset) : reset());
			}
		} finally {
			this.rebuildRelay(); // always restart sync, even if the reset failed (the error still reaches the caller)
		}
	}

	// Tries details that may not be saved yet. Rejects with a CloudError saying what went wrong. Creates the folder.
	async testWebDav(input: SyncSettings): Promise<void> {
		const folderPath = normalizeFolderPath(input.folderPath);
		const transport = new WebDavTransport({ url: input.webdavUrl, username: input.username.trim(), password: input.password }, { fetch: this.options.fetch });
		await transport.ensureFolder(folderPath);
		await transport.listFiles(folderPath);
	}

	// Forgets only the password, so reconnecting to the same server keeps its sync position.
	disconnectWebDav(): void {
		this.settings = saveSyncSettings({ ...this.settings, password: '' }, this.storage);
		this.rebuildRelay();
	}

	// Run one cycle on each path, one after the other: they share a lock that makes the loser skip its turn.
	async syncNow(): Promise<SyncControllerState> {
		await this.relay?.syncNow();
		for (const { service } of [...this.peerSyncs.values()]) await service.syncNow();
		return this.state;
	}

	// Call after a local write. Only WebDAV needs telling: a nearby device pulls on its own schedule. Offline, the outbox
	// keeps the change and the service's 'online' listener syncs on reconnect, so no doomed request is made.
	requestSync(): void {
		if (globalThis.navigator?.onLine === false) return;
		this.relay?.requestSync();
	}

	private get storage(): KeyValueStorage {
		return this.options.storage ?? localStorage;
	}

	private rebuildRelay(): void {
		this.detachRelay?.();
		this.relay?.stop();
		this.detachRelay = this.relay = null;
		this.relayState = IDLE;

		const { webdavUrl, username, password, folderPath } = this.settings;
		if (!webdavUrl) {
			this.relayConnection = 'unconfigured';
			this.publish();
			return;
		}
		if (!username || !password) {
			this.relayConnection = 'disconnected';
			this.publish();
			return;
		}

		this.relayConnection = 'connected';
		const service = new SyncService({
			transport: new WebDavTransport({ url: webdavUrl, username, password }, { fetch: this.options.fetch }),
			identity: this.getIdentity(),
			folderPath,
			repository: this.options.repository
		});
		this.relay = service;
		const absorb = this.summaryTracker(service);
		this.detachRelay = service.subscribe((syncState) => {
			this.relayState = syncState;
			absorb(syncState);
			if (syncState.error?.kind === 'auth') {
				// Repeated bad logins get an account locked out on many servers. Stay stopped until the details change.
				this.relayConnection = 'disconnected';
				service.stop();
			}
			this.publish();
		});
		service.start();
	}

	private startPeer(transport: PeerTransport): void {
		const service = new SyncService({ transport, identity: this.getIdentity(), repository: this.options.repository });
		const peer: PeerSync = { service, detach: () => {}, state: service.getState() };
		this.peerSyncs.set(transport.peerDeviceId, peer);
		const absorb = this.summaryTracker(service);
		peer.detach = service.subscribe((syncState) => {
			peer.state = syncState;
			absorb(syncState);
			this.publish();
		});
		service.start();
	}

	private stopPeer(deviceId: string): void {
		const peer = this.peerSyncs.get(deviceId);
		peer?.detach();
		peer?.service.stop();
		this.peerSyncs.delete(deviceId);
		this.publish();
	}

	// Services re-send their last summary with every status change. Only a new one may reach the store, because
	// onRemoteChanges treats a new summary as "changes arrived" and open screens reload on it.
	private summaryTracker(service: SyncService): (state: SyncState) => void {
		let seen: SyncCycleSummary | null = null;
		return ({ lastSummary, lastSyncedAt }) => {
			if (lastSyncedAt && (!this.lastSyncedAt || lastSyncedAt > this.lastSyncedAt)) this.lastSyncedAt = lastSyncedAt;
			if (!lastSummary || lastSummary === seen) return;
			seen = lastSummary;
			this.droppedByService.set(service, lastSummary.droppedOrphans);
			const droppedOrphans = [...this.droppedByService.values()].reduce((total, dropped) => total + dropped, 0);
			this.lastSummary = { ...lastSummary, droppedOrphans };
		};
	}

	private publish(): void {
		const states = [this.relayState, ...[...this.peerSyncs.values()].map((peer) => peer.state)];
		const nearby = this.nearby.getState();
		const peers = this.nearby.getPeers();
		const linked = peers.some((peer) => peer.linked);
		this.screenWake.set(linked);
		this.state = {
			status: combinedStatus(states),
			lastSyncedAt: this.lastSyncedAt,
			lastSummary: this.lastSummary,
			error: states.find((state) => state.error)?.error ?? null,
			connection: linked ? 'connected' : this.relayConnection,
			nearby,
			peers
		};
		for (const listener of this.listeners) listener(this.state);
	}
}
