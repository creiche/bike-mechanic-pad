import { pullPeerId, pushPeerId, SyncProtocolError, syncRepository, type SyncRepository } from '../db/repositories/sync';
import { CloudError, type CloudErrorKind, type CloudStorageAdapter } from './cloud/types';
import type { DeviceIdentity } from './device';
import { buildPacket, packetFileName, parsePacket, parsePacketFileName, type PacketRef, type SyncPacket } from './packet';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';
export type SyncErrorKind = CloudErrorKind | 'protocol' | 'internal';

export interface SyncCycleSummary {
	pushedPackets: number;
	pushedDeltas: number;
	pulledPackets: number;
	appliedDeltas: number;
	// Packets held back because a parent row has not arrived yet; retried next cycle.
	skippedDeltas: number;
	prunedRows: number;
}

export interface SyncState {
	status: SyncStatus;
	lastSyncedAt: string | null;
	lastSummary: SyncCycleSummary | null;
	error: { kind: SyncErrorKind; message: string } | null;
}

export interface SyncServiceOptions {
	adapter: CloudStorageAdapter;
	identity: DeviceIdentity;
	repository?: SyncRepository;
	folderPath?: string;
	batchSize?: number;
	// Foreground / hidden-tab polling and the push debounce window (see ARCHITECTURE.md 2.5).
	pollIntervalMs?: number;
	backgroundPollIntervalMs?: number;
	debounceMs?: number;
	now?: () => Date;
}

export const DEFAULT_SYNC_FOLDER = '/sync';
const LOCK_NAME = 'bike-mechanic-pad-sync';
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

// Exponential backoff with "equal jitter": half fixed, half random, so devices do not retry in lockstep.
export function computeBackoffMs(failures: number, random: () => number = Math.random): number {
	const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
	return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

function describeFailure(error: unknown): { status: SyncStatus; kind: SyncErrorKind; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof CloudError) {
		const offline = error.kind === 'offline' || error.kind === 'timeout';
		return { status: offline ? 'offline' : 'error', kind: error.kind, message };
	}
	return { status: 'error', kind: error instanceof SyncProtocolError ? 'protocol' : 'internal', message };
}

// Runs the push -> pull -> prune cycle against one cloud relay. Implements the Svelte store contract
// (`subscribe`), so components can read it as `$syncService`.
export class SyncService {
	private readonly adapter: CloudStorageAdapter;
	private readonly identity: DeviceIdentity;
	private readonly repository: SyncRepository;
	private readonly folderPath: string;
	private readonly batchSize: number;
	private readonly pollIntervalMs: number;
	private readonly backgroundPollIntervalMs: number;
	private readonly debounceMs: number;
	private readonly now: () => Date;

	private state: SyncState = { status: 'idle', lastSyncedAt: null, lastSummary: null, error: null };
	private readonly listeners = new Set<(state: SyncState) => void>();
	private inFlight: Promise<SyncState> | null = null;
	private consecutiveFailures = 0;
	private running = false;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: SyncServiceOptions) {
		this.adapter = options.adapter;
		this.identity = options.identity;
		this.repository = options.repository ?? syncRepository;
		this.folderPath = options.folderPath ?? DEFAULT_SYNC_FOLDER;
		this.batchSize = options.batchSize ?? 500;
		this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
		this.backgroundPollIntervalMs = options.backgroundPollIntervalMs ?? 45_000;
		this.debounceMs = options.debounceMs ?? 2_000;
		this.now = options.now ?? (() => new Date());
	}

	getState(): SyncState {
		return this.state;
	}

	subscribe(listener: (state: SyncState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	// Run one full cycle now. Calls made while a cycle is running share that cycle. Never rejects.
	syncNow(): Promise<SyncState> {
		this.inFlight ??= this.runCycleSafely().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	// Call after a local write: batches bursts of edits into one push.
	requestSync(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.syncNow();
		}, this.debounceMs);
	}

	// Begin background polling; also syncs on reconnect and when the tab becomes visible again.
	start(): void {
		if (this.running) return;
		this.running = true;
		globalThis.addEventListener?.('online', this.wake);
		globalThis.document?.addEventListener('visibilitychange', this.wake);
		void this.tick();
	}

	stop(): void {
		this.running = false;
		globalThis.removeEventListener?.('online', this.wake);
		globalThis.document?.removeEventListener('visibilitychange', this.wake);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.pollTimer = this.debounceTimer = null;
	}

	private readonly wake = (): void => {
		if (this.running && !globalThis.document?.hidden) {
			if (this.pollTimer) clearTimeout(this.pollTimer);
			void this.tick();
		}
	};

	private async tick(): Promise<void> {
		await this.syncNow();
		if (!this.running) return;

		const delay =
			this.consecutiveFailures > 0
				? computeBackoffMs(this.consecutiveFailures)
				: globalThis.document?.hidden
					? this.backgroundPollIntervalMs
					: this.pollIntervalMs;
		if (this.pollTimer) clearTimeout(this.pollTimer); // a wake-up may have started a second tick chain
		this.pollTimer = setTimeout(() => void this.tick(), delay);
	}

	private setState(patch: Partial<SyncState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}

	private async runCycleSafely(): Promise<SyncState> {
		const previous = this.state;
		this.setState({ status: 'syncing' });

		try {
			const summary = await this.withTabLock(() => this.runCycle());
			if (summary === null) {
				this.setState({ status: previous.status === 'syncing' ? 'idle' : previous.status }); // another tab is syncing
			} else {
				this.consecutiveFailures = 0;
				this.setState({ status: 'idle', lastSyncedAt: this.now().toISOString(), lastSummary: summary, error: null });
			}
		} catch (error) {
			this.consecutiveFailures++;
			const failure = describeFailure(error);
			this.setState({ status: failure.status, error: { kind: failure.kind, message: failure.message } });
		}

		return this.state;
	}

	// Two tabs of the same app share one outbox, so only one may sync at a time. Returns null when skipped.
	private async withTabLock<T>(work: () => Promise<T>): Promise<T | null> {
		const locks = globalThis.navigator?.locks;
		if (!locks) return work();
		return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? work() : null));
	}

	private async runCycle(): Promise<SyncCycleSummary> {
		await this.adapter.ensureFolder(this.folderPath);

		const push = await this.pushPhase();
		const pull = await this.pullPhase();
		const prunedRows = await this.prunePhase();
		return { ...push, ...pull, prunedRows };
	}

	// Upload every local delta the relay has not seen, in packets of at most `batchSize` rows.
	private async pushPhase(): Promise<Pick<SyncCycleSummary, 'pushedPackets' | 'pushedDeltas'>> {
		const relayId = pushPeerId(this.adapter.id);
		let pushedPackets = 0;
		let pushedDeltas = 0;

		for (;;) {
			const { deltas } = await this.repository.getSyncDelta(relayId, this.batchSize);
			if (deltas.length === 0) break;

			const packet = buildPacket(this.identity, deltas);
			await this.uploadPacket(packet);
			await this.repository.acknowledgeSync(relayId, this.adapter.displayName, packet.endSeq);

			pushedPackets++;
			pushedDeltas += deltas.length;
			if (deltas.length < this.batchSize) break;
		}

		return { pushedPackets, pushedDeltas };
	}

	// A taken file name means an earlier attempt already uploaded this exact range (the ack was lost).
	// Identical content is fine; different content means two devices share an id, which must not pass silently.
	private async uploadPacket(packet: SyncPacket): Promise<void> {
		const name = packetFileName(packet);
		const content = JSON.stringify(packet);

		try {
			await this.adapter.uploadFile(this.folderPath, name, content);
		} catch (error) {
			if (!(error instanceof CloudError && error.kind === 'conflict')) throw error;
			const existing = await this.adapter.downloadFile(this.folderPath, name);
			if (existing !== content) {
				throw new CloudError('conflict', `Remote packet ${name} already exists with different content.`, { cause: error });
			}
		}
	}

	// Apply packets from other devices, oldest first per device. One device's bad packet stops only that device.
	private async pullPhase(): Promise<Pick<SyncCycleSummary, 'pulledPackets' | 'appliedDeltas' | 'skippedDeltas'>> {
		const files = await this.adapter.listFiles(this.folderPath);
		const byDevice = new Map<string, PacketRef[]>();
		for (const file of files) {
			const ref = parsePacketFileName(file.name);
			if (!ref || ref.deviceId === this.identity.deviceId) continue;
			byDevice.set(ref.deviceId, [...(byDevice.get(ref.deviceId) ?? []), ref]);
		}

		let pulledPackets = 0;
		let appliedDeltas = 0;
		let skippedDeltas = 0;
		const failures: unknown[] = [];

		for (const [deviceId, refs] of byDevice) {
			const peerId = pullPeerId(deviceId);
			const cursor = (await this.repository.getPeerState(peerId))?.last_synced_seq ?? 0;
			const pending = refs.filter((ref) => ref.endSeq > cursor).sort((a, b) => a.startSeq - b.startSeq);

			for (const ref of pending) {
				try {
					const text = await this.adapter.downloadFile(this.folderPath, packetFileName(ref));
					const packet = parsePacket(text, ref);
					const result = await this.repository.applyRemoteDeltas(peerId, packet.deviceName, packet.deltas);
					pulledPackets++;
					appliedDeltas += result.applied;
					if (result.blocked) {
						// A parent row from another device has not arrived yet: retry this packet next cycle.
						skippedDeltas++;
						break;
					}
				} catch (error) {
					if (error instanceof CloudError) throw error; // offline/auth/rate limit affect every device
					failures.push(error);
					break; // keep order: never apply later packets past a failed one
				}
			}
		}

		if (failures.length > 0) throw failures[0];
		return { pulledPackets, appliedDeltas, skippedDeltas };
	}

	// Housekeeping only: a failure here must not mark an otherwise successful sync as failed.
	private async prunePhase(): Promise<number> {
		try {
			return await this.repository.pruneStaleOutboxLogs();
		} catch (error) {
			console.warn('Outbox pruning failed.', error);
			return 0;
		}
	}
}
