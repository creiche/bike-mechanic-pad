import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyRemoteOptions, ApplyRemoteResult, OutboxEntry, SyncRepository } from '../db/repositories/sync';
import { CloudError, type CloudStorageAdapter, type RemoteFile } from './cloud/types';
import { buildPacket, packetFileName, parsePacket } from './packet';
import { computeBackoffMs, SyncService } from './syncService';

const FOLDER = '/sync';
const self = { deviceId: 'dev-self', deviceName: 'Stand iPad' };
const peer = { deviceId: 'dev-peer', deviceName: 'Office Mac' };

const delta = (seq: number): OutboxEntry => ({
	seq,
	id: `evt-${seq}`,
	entity_type: 'customer',
	entity_id: `c${seq}`,
	action: 'INSERT',
	payload: '{}',
	created_at: '2026-11-07T10:00:00.000Z'
});

class FakeAdapter implements CloudStorageAdapter {
	readonly id = 'fake';
	readonly displayName = 'Fake Cloud';
	files = new Map<string, string>();
	failWith: CloudError | null = null;
	uploads: string[] = [];
	isConnected = () => true;
	disconnect = async () => {};

	private check() {
		if (this.failWith) throw this.failWith;
	}
	async ensureFolder() {
		this.check();
	}
	async uploadFile(_folder: string, name: string, content: string) {
		this.check();
		if (this.files.has(name)) throw new CloudError('conflict', 'exists');
		this.files.set(name, content);
		this.uploads.push(name);
	}
	async listFiles(): Promise<RemoteFile[]> {
		this.check();
		return [...this.files.keys(), 'notes.txt'].map((name) => ({ name, size: 1, modifiedAt: '' }));
	}
	async downloadFile(_folder: string, name: string) {
		this.check();
		const content = this.files.get(name);
		if (content === undefined) throw new CloudError('not_found', 'missing');
		return content;
	}
}

function fakeRepository(outbox: OutboxEntry[] = []) {
	const cursors = new Map<string, number>();
	const repository = {
		getSyncDelta: vi.fn(async (peerId: string, limit = 500) => ({
			deltas: outbox.filter((row) => row.seq > (cursors.get(peerId) ?? 0)).slice(0, limit),
			peer: null
		})),
		acknowledgeSync: vi.fn(async (peerId: string, _name: string, seq: number) => {
			cursors.set(peerId, Math.max(cursors.get(peerId) ?? 0, seq));
		}),
		getPeerState: vi.fn(async (peerId: string) =>
			cursors.has(peerId)
				? { peer_id: peerId, peer_name: '', last_synced_seq: cursors.get(peerId)!, last_seen_at: '' }
				: null
		),
		deletePeerState: vi.fn(async (peerId: string) => {
			cursors.delete(peerId);
		}),
		applyRemoteDeltas: vi.fn(async (peerId: string, _name: string, deltas: OutboxEntry[], _options?: ApplyRemoteOptions): Promise<ApplyRemoteResult> => {
			const last = Math.max(...deltas.map((row) => row.seq));
			cursors.set(peerId, last);
			return { applied: deltas.length, blocked: false, blockedAt: null, dropped: 0, lastSyncedSeq: last };
		}),
		pruneStaleOutboxLogs: vi.fn(async () => 0)
	} satisfies SyncRepository;
	return { repository, cursors };
}

const putPacket = (adapter: FakeAdapter, deltas: OutboxEntry[]) => {
	const packet = buildPacket(peer, deltas);
	adapter.files.set(packetFileName(packet), JSON.stringify(packet));
};

function setup(outbox: OutboxEntry[] = [], batchSize = 500) {
	const adapter = new FakeAdapter();
	const { repository, cursors } = fakeRepository(outbox);
	const service = new SyncService({
		adapter,
		identity: self,
		repository,
		folderPath: FOLDER,
		batchSize,
		now: () => new Date('2026-11-08T00:00:00.000Z')
	});
	return { adapter, repository, cursors, service };
}

describe('SyncService push phase', () => {
	it('uploads unsynced deltas as a packet and acknowledges the end seq', async () => {
		const { adapter, repository, service } = setup([delta(1), delta(2), delta(3)]);

		const state = await service.syncNow();

		expect(state.status).toBe('idle');
		expect(state.lastSyncedAt).toBe('2026-11-08T00:00:00.000Z');
		expect(state.lastSummary).toMatchObject({ pushedPackets: 1, pushedDeltas: 3 });
		const packet = JSON.parse(adapter.files.get(packetFileName({ ...self, startSeq: 1, endSeq: 3 }))!);
		expect(packet).toMatchObject({ deviceId: 'dev-self', deviceName: 'Stand iPad', startSeq: 1, endSeq: 3 });
		expect(repository.acknowledgeSync).toHaveBeenCalledWith('relay:fake:/sync', 'Fake Cloud', 3);
	});

	it('splits large backlogs into several packets', async () => {
		const { adapter, service } = setup([delta(1), delta(2), delta(3)], 2);

		await service.syncNow();

		expect(adapter.uploads).toHaveLength(2);
	});

	it('does not acknowledge when the upload fails, so the next cycle retries', async () => {
		const { adapter, repository, service } = setup([delta(1)]);
		adapter.failWith = new CloudError('server', 'boom');

		const state = await service.syncNow();

		expect(state.status).toBe('error');
		expect(repository.acknowledgeSync).not.toHaveBeenCalled();

		adapter.failWith = null;
		expect((await service.syncNow()).status).toBe('idle');
		expect(repository.acknowledgeSync).toHaveBeenCalledWith('relay:fake:/sync', 'Fake Cloud', 1);
	});

	it('uploads everything again to a new folder', async () => {
		const { repository, service } = setup([delta(1)]);
		await service.syncNow();

		const moved = new FakeAdapter();
		await new SyncService({ adapter: moved, identity: self, repository, folderPath: '/elsewhere' }).syncNow();

		expect(moved.uploads).toHaveLength(1);
	});

	it('accepts an existing packet that differs only by device name', async () => {
		const { adapter, repository, service } = setup([delta(1)]);
		const packet = buildPacket({ ...self, deviceName: 'Old name' }, [delta(1)]);
		adapter.files.set(packetFileName(packet), JSON.stringify(packet));

		expect((await service.syncNow()).status).toBe('idle');
		expect(repository.acknowledgeSync).toHaveBeenCalledTimes(1);
	});

	it('treats an identical existing packet as already uploaded', async () => {
		const { adapter, repository, service } = setup([delta(1)]);
		const packet = buildPacket(self, [delta(1)]);
		adapter.files.set(packetFileName(packet), JSON.stringify(packet));

		const state = await service.syncNow();

		expect(state.status).toBe('idle');
		expect(repository.acknowledgeSync).toHaveBeenCalledTimes(1);
	});

	it('fails when an existing packet with the same name has different content', async () => {
		const { adapter, repository, service } = setup([delta(1)]);
		adapter.files.set(packetFileName({ ...self, startSeq: 1, endSeq: 1 }), '{"other":true}');

		const state = await service.syncNow();

		expect(state.error?.kind).toBe('conflict');
		expect(repository.acknowledgeSync).not.toHaveBeenCalled();
	});
});

describe('SyncService pull phase', () => {
	it('applies peer packets in order and ignores its own and unrelated files', async () => {
		const { adapter, repository, service } = setup([delta(1)]);
		putPacket(adapter, [delta(3), delta(4)]);
		putPacket(adapter, [delta(1), delta(2)]);

		const state = await service.syncNow();

		expect(state.lastSummary).toMatchObject({ pulledPackets: 2, appliedDeltas: 4, pushedPackets: 1 });
		const applied = repository.applyRemoteDeltas.mock.calls.map(([peerId, name, rows]) => [peerId, name, rows[0].seq]);
		expect(applied).toEqual([
			['pull:dev-peer', 'Office Mac', 1],
			['pull:dev-peer', 'Office Mac', 3]
		]);
		expect(repository.applyRemoteDeltas.mock.calls.some(([peerId]) => peerId === 'pull:dev-self')).toBe(false);
	});

	it('replays its own packets once after a restore, starting from the restore cursor', async () => {
		const { adapter, repository, cursors, service } = setup();
		const own = buildPacket(self, [delta(3), delta(4)]);
		adapter.files.set(packetFileName(own), JSON.stringify(own));
		cursors.set('pull:dev-self', 2);

		await service.syncNow();
		expect(repository.applyRemoteDeltas.mock.calls.map(([peerId]) => peerId)).toEqual(['pull:dev-self']);
		expect(repository.deletePeerState).toHaveBeenCalledWith('pull:dev-self');

		await service.syncNow();
		expect(repository.applyRemoteDeltas).toHaveBeenCalledTimes(1);
	});

	it('keeps the replay cursor when its own packet is still blocked', async () => {
		const { adapter, repository, cursors, service } = setup();
		const own = buildPacket(self, [delta(3)]);
		adapter.files.set(packetFileName(own), JSON.stringify(own));
		cursors.set('pull:dev-self', 2);
		repository.applyRemoteDeltas.mockImplementation(async () => ({
			applied: 1,
			blocked: true,
			blockedAt: '2026-01-01T00:00:00.000Z',
			dropped: 0,
			lastSyncedSeq: 2
		}));

		await service.syncNow();
		expect(repository.deletePeerState).not.toHaveBeenCalled();
	});

	it('skips packets at or below the peer watermark', async () => {
		const { adapter, repository, cursors, service } = setup();
		putPacket(adapter, [delta(1), delta(2)]);
		cursors.set('pull:dev-peer', 2);

		await service.syncNow();

		expect(repository.applyRemoteDeltas).not.toHaveBeenCalled();
	});

	it('reports a protocol error for a malformed packet and does not prune', async () => {
		const { adapter, repository, service } = setup();
		adapter.files.set(packetFileName({ ...peer, startSeq: 1, endSeq: 1 }), 'not json');

		const state = await service.syncNow();

		expect(state.status).toBe('error');
		expect(state.error?.kind).toBe('protocol');
		expect(repository.pruneStaleOutboxLogs).not.toHaveBeenCalled();
	});

	it('does not apply later packets past a failed one', async () => {
		const { adapter, repository, service } = setup();
		adapter.files.set(packetFileName({ ...peer, startSeq: 1, endSeq: 1 }), 'not json');
		putPacket(adapter, [delta(2)]);

		await service.syncNow();

		expect(repository.applyRemoteDeltas).not.toHaveBeenCalled();
	});
});

describe('SyncService stalled devices', () => {
	const other = { deviceId: 'dev-other', deviceName: 'Phone' };
	const blocked = (blockedAt: string) => ({ applied: 0, blocked: true, blockedAt, dropped: 0, lastSyncedSeq: 0 });
	const moved = { applied: 1, blocked: false, blockedAt: null, dropped: 0, lastSyncedSeq: 1 };

	function setupTwoDevices() {
		const context = setup();
		putPacket(context.adapter, [delta(1)]);
		const packet = buildPacket(other, [delta(1)]);
		context.adapter.files.set(packetFileName(packet), JSON.stringify(packet));
		const dropCalls = () =>
			context.repository.applyRemoteDeltas.mock.calls.filter((call) => call[3]?.dropFirstOrphan).map((call) => call[0]);
		return { ...context, dropCalls };
	}

	it('gives up on only the oldest blocked change when nothing moved, and reports it', async () => {
		const { repository, service, dropCalls } = setupTwoDevices();
		repository.applyRemoteDeltas.mockImplementation(async (peerId, _name, _deltas, options) =>
			options?.dropFirstOrphan
				? { ...moved, dropped: 1 }
				: blocked(peerId === 'pull:dev-other' ? '2026-01-01T00:00:00.000Z' : '2026-06-01T00:00:00.000Z')
		);

		const state = await service.syncNow();

		expect(dropCalls()).toEqual(['pull:dev-other']);
		expect(state.status).toBe('idle');
		expect(state.lastSummary?.droppedOrphans).toBe(1);
	});

	it('keeps waiting while another device is still making progress', async () => {
		const { repository, service, dropCalls } = setupTwoDevices();
		repository.applyRemoteDeltas.mockImplementation(async (peerId) =>
			peerId === 'pull:dev-peer' ? blocked('2026-01-01T00:00:00.000Z') : moved
		);

		await service.syncNow();

		expect(dropCalls()).toEqual([]);
	});

	it('keeps waiting when a packet could not be read, since it may hold the parent', async () => {
		const { adapter, repository, service, dropCalls } = setupTwoDevices();
		adapter.files.set(packetFileName({ ...other, startSeq: 1, endSeq: 1 }), 'not json');
		repository.applyRemoteDeltas.mockImplementation(async () => blocked('2026-01-01T00:00:00.000Z'));

		await service.syncNow();

		expect(dropCalls()).toEqual([]);
	});
});

describe('SyncService status reporting', () => {
	it('prunes after a successful cycle', async () => {
		const { repository, service } = setup();

		await service.syncNow();

		expect(repository.pruneStaleOutboxLogs).toHaveBeenCalledTimes(1);
	});

	it.each([
		['offline', 'offline'],
		['timeout', 'offline'],
		['auth', 'error'],
		['rate_limit', 'error']
	] as const)('maps a %s failure to status %s and recovers afterwards', async (kind, status) => {
		const { adapter, repository, service } = setup();
		adapter.failWith = new CloudError(kind, 'failed');

		const state = await service.syncNow();

		expect(state).toMatchObject({ status, error: { kind, message: 'failed' } });
		expect(repository.pruneStaleOutboxLogs).not.toHaveBeenCalled();

		adapter.failWith = null;
		expect(await service.syncNow()).toMatchObject({ status: 'idle', error: null });
	});

	it('shares one cycle between concurrent callers', async () => {
		const { adapter, service } = setup();
		const ensureFolder = vi.spyOn(adapter, 'ensureFolder');

		await Promise.all([service.syncNow(), service.syncNow()]);

		expect(ensureFolder).toHaveBeenCalledTimes(1);
	});

	it('notifies subscribers, starting with the current state', async () => {
		const { service } = setup();
		const seen: string[] = [];
		service.subscribe((state) => seen.push(state.status));

		await service.syncNow();

		expect(seen).toEqual(['idle', 'syncing', 'idle']);
	});
});

describe('SyncService requestSync', () => {
	afterEach(() => vi.useRealTimers());

	it('batches a burst of requests into one cycle after the quiet window', async () => {
		vi.useFakeTimers();
		const { adapter, service } = setup();
		const ensureFolder = vi.spyOn(adapter, 'ensureFolder');

		service.requestSync();
		await vi.advanceTimersByTimeAsync(1_500);
		service.requestSync(); // restarts the window
		await vi.advanceTimersByTimeAsync(1_500);
		expect(ensureFolder).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(600);
		expect(ensureFolder).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(ensureFolder).toHaveBeenCalledTimes(1);
	});

	it('does not reject or throw when the debounced cycle fails offline', async () => {
		vi.useFakeTimers();
		const { adapter, service } = setup();
		adapter.failWith = new CloudError('offline', 'The device is offline.');

		service.requestSync();
		await vi.advanceTimersByTimeAsync(2_100);

		expect(service.getState()).toMatchObject({ status: 'offline', error: { kind: 'offline' } });
	});

	it('drops a pending request on stop()', async () => {
		vi.useFakeTimers();
		const { adapter, service } = setup();
		const ensureFolder = vi.spyOn(adapter, 'ensureFolder');

		service.requestSync();
		service.stop();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(ensureFolder).not.toHaveBeenCalled();
	});
});

describe('computeBackoffMs', () => {
	it('grows exponentially, stays within [ceiling/2, ceiling], and is capped', () => {
		expect(computeBackoffMs(1, () => 0)).toBe(1_000);
		expect(computeBackoffMs(1, () => 1)).toBe(2_000);
		expect(computeBackoffMs(3, () => 1)).toBe(8_000);
		expect(computeBackoffMs(50, () => 1)).toBe(300_000);
	});
});

describe('packets', () => {
	it('rejects a packet whose content does not match its file name', () => {
		const packet = buildPacket(peer, [delta(1)]);

		expect(() => parsePacket(JSON.stringify(packet), { deviceId: 'someone-else', startSeq: 1, endSeq: 1 })).toThrow(
			'does not match'
		);
	});

	it('rejects deltas outside the declared seq range', () => {
		const packet = { ...buildPacket(peer, [delta(1)]), deltas: [delta(9)] };

		expect(() => parsePacket(JSON.stringify(packet), { ...peer, startSeq: 1, endSeq: 1 })).toThrow('malformed');
	});
});
