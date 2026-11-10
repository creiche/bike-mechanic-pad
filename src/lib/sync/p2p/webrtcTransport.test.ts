import { describe, expect, it, vi } from 'vitest';
import type { ApplyRemoteResult, OutboxEntry, PeerSyncRepository, SyncRepository } from '../../db/repositories/sync';
import { CloudError } from '../cloud/types';
import { packetFileName } from '../packet';
import { SyncService } from '../syncService';
import { FrameAssembler, sendFramed } from './framing';
import type { PeerLink } from './pairing';
import { parsePeerMessage, virtualPacketNames } from './protocol';
import { WebRtcTransport, type WebRtcTransportOptions } from './webrtcTransport';

type Listener = (event: { data?: ArrayBuffer }) => void;

class FakeChannel {
	readyState: RTCDataChannelState = 'open';
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	other!: FakeChannel;
	private readonly listeners = new Map<string, Set<Listener>>();

	addEventListener(type: string, listener: Listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	removeEventListener(type: string, listener: Listener) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: { data?: ArrayBuffer } = {}) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
	send(frame: Uint8Array) {
		if (this.readyState !== 'open') throw new Error('InvalidStateError');
		const data = frame.slice().buffer;
		queueMicrotask(() => this.other.emit('message', { data }));
	}
	close() {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		this.emit('close');
		queueMicrotask(() => this.other.close());
	}
}

class FakePeerConnection {
	connectionState: RTCPeerConnectionState = 'connected';
	private listener: Listener = () => {};
	closed = false;
	addEventListener(_type: string, listener: Listener) {
		this.listener = listener;
	}
	fail() {
		this.connectionState = 'failed';
		this.listener({});
	}
	close() {
		this.closed = true;
	}
}

function linkedPair() {
	const [a, b] = [new FakeChannel(), new FakeChannel()];
	a.other = b;
	b.other = a;
	const pc = new FakePeerConnection();
	const link = (channel: FakeChannel, connection = new FakePeerConnection()) =>
		({ channel, pc: connection }) as unknown as PeerLink;
	return { a, b, pc, linkA: link(a, pc), linkB: link(b) };
}

const stand = { deviceId: 'dev-stand', deviceName: 'Stand iPad' };
const office = { deviceId: 'dev-office', deviceName: 'Office Mac' };

const row = (seq: number, payload = '{}'): OutboxEntry => ({
	seq,
	id: `evt-${seq}`,
	entity_type: 'customer',
	entity_id: `c${seq}`,
	action: 'INSERT',
	payload,
	created_at: '2026-11-07T10:00:00.000Z'
});

function fakeRepository(outbox: OutboxEntry[] = [], knownDevices: string[] = []) {
	const cursors = new Map<string, number>();
	const repository = {
		acknowledgeSync: vi.fn(async () => {}),
		getPeerState: vi.fn(async (peerId: string) =>
			cursors.has(peerId) ? { peer_id: peerId, peer_name: '', last_synced_seq: cursors.get(peerId)!, last_seen_at: '' } : null
		),
		getOutboxSeqs: vi.fn(async (afterSeq: number) => outbox.filter((entry) => entry.seq > afterSeq).map((entry) => entry.seq)),
		getOutboxRange: vi.fn(async (startSeq: number, endSeq: number, limit: number) =>
			outbox.filter((entry) => entry.seq >= startSeq && entry.seq <= endSeq).slice(0, limit)
		),
		getKnownDeviceIds: vi.fn(async () => knownDevices)
	} satisfies PeerSyncRepository;
	return { repository, cursors };
}

type Overrides = Partial<WebRtcTransportOptions>;

async function connectedPair(standOptions: Overrides = {}, officeOptions: Overrides = {}) {
	const pair = linkedPair();
	const standRepo = fakeRepository();
	const officeRepo = fakeRepository([row(1), row(2), row(3)]);
	const [standSide, officeSide] = await Promise.all([
		WebRtcTransport.connect(pair.linkA, { identity: stand, repository: standRepo.repository, ...standOptions }),
		WebRtcTransport.connect(pair.linkB, { identity: office, repository: officeRepo.repository, ...officeOptions })
	]);
	return { ...pair, standSide, officeSide, standRepo, officeRepo };
}

describe('WebRtcTransport handshake', () => {
	it('learns who is on the other end', async () => {
		const { standSide, officeSide } = await connectedPair();
		expect(standSide.displayName).toBe('Office Mac');
		expect(standSide.id).toBe('webrtc:dev-office');
		expect(officeSide.displayName).toBe('Stand iPad');
		expect(standSide.isConnected()).toBe(true);
	});

	it('refuses a device with the same id', async () => {
		const { linkA, linkB } = linkedPair();
		const repository = fakeRepository().repository;
		const results = await Promise.allSettled([
			WebRtcTransport.connect(linkA, { identity: stand, repository }),
			WebRtcTransport.connect(linkB, { identity: stand, repository })
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
	});

	it('refuses an incompatible protocol version', async () => {
		const { linkA, b } = linkedPair();
		const connecting = WebRtcTransport.connect(linkA, { identity: stand, repository: fakeRepository().repository });
		await sendFramed(b as unknown as RTCDataChannel, JSON.stringify({ t: 'hello', protocol: 99, ...office }));
		await expect(connecting).rejects.toThrow(/different app versions/);
	});

	it('times out and closes when the other device never answers', async () => {
		const { linkA, pc } = linkedPair();
		const connecting = WebRtcTransport.connect(linkA, { identity: stand, repository: fakeRepository().repository, connectTimeoutMs: 5 });
		await expect(connecting).rejects.toMatchObject({ kind: 'timeout' });
		expect(pc.closed).toBe(true);
	});

	it('says hello once a connecting channel opens', async () => {
		const { a, b, linkA } = linkedPair();
		a.readyState = 'connecting';
		const frames: ArrayBuffer[] = [];
		b.addEventListener('message', (event) => frames.push(event.data!));
		void WebRtcTransport.connect(linkA, { identity: stand, repository: fakeRepository().repository, connectTimeoutMs: 20 }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(frames).toHaveLength(0);

		a.readyState = 'open';
		a.emit('open');
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(parsePeerMessage(new FrameAssembler().push(frames[0])!)).toMatchObject({ t: 'hello', deviceId: 'dev-stand' });
	});
});

describe('WebRtcTransport as a virtual folder', () => {
	it('lists the peer outbox as packets after this device\'s cursor', async () => {
		const { standSide, standRepo } = await connectedPair();
		standRepo.cursors.set('pull:dev-office', 1);

		const files = await standSide.listFiles();

		expect(files.map((file) => file.name)).toEqual([packetFileName({ deviceId: 'dev-office', startSeq: 2, endSeq: 3 })]);
	});

	it('treats the list request as a durable ack of the requester\'s cursor', async () => {
		const { standSide, standRepo, officeRepo } = await connectedPair();
		standRepo.cursors.set('pull:dev-office', 2);

		await standSide.listFiles();

		expect(officeRepo.repository.acknowledgeSync).toHaveBeenCalledWith('relay:webrtc:dev-stand', 'Stand iPad', 2);
	});

	it('downloads a packet the receiving side can validate', async () => {
		const { standSide } = await connectedPair();
		const name = packetFileName({ deviceId: 'dev-office', startSeq: 1, endSeq: 2 });

		const packet = JSON.parse(await standSide.downloadFile('/', name));

		expect(packet).toMatchObject({ deviceId: 'dev-office', startSeq: 1, endSeq: 2, count: 2 });
	});

	it('refuses packets claiming to come from another device', async () => {
		const { standSide } = await connectedPair();
		const name = packetFileName({ deviceId: 'dev-third', startSeq: 1, endSeq: 2 });
		await expect(standSide.downloadFile('/', name)).rejects.toThrow(/not a packet from/);
	});

	it('drops listed names that belong to another device', async () => {
		const { b, linkA } = linkedPair();
		const connecting = WebRtcTransport.connect(linkA, { identity: stand, repository: fakeRepository().repository });
		const peerChannel = b as unknown as RTCDataChannel;
		await sendFramed(peerChannel, JSON.stringify({ t: 'hello', protocol: 1, ...office }));
		const transport = await connecting;

		const listing = transport.listFiles();
		await new Promise((resolve) => setTimeout(resolve, 1));
		const files = [packetFileName({ deviceId: 'dev-third', startSeq: 1, endSeq: 1 }), packetFileName({ deviceId: 'dev-office', startSeq: 1, endSeq: 1 })];
		await sendFramed(peerChannel, JSON.stringify({ t: 'ok', rid: 1, body: { files, knownDevices: [] } }));

		expect((await listing).map((file) => file.name)).toEqual([files[1]]);
	});

	it('serves both directions at once', async () => {
		const { standSide, officeSide } = await connectedPair();
		const [fromOffice, fromStand] = await Promise.all([standSide.listFiles(), officeSide.listFiles()]);
		expect(fromOffice).toHaveLength(1);
		expect(fromStand).toHaveLength(0);
	});

	it('reports whether a third device exists, from either side', async () => {
		const quiet = await connectedPair();
		expect(quiet.standSide.isOnlyPeer()).toBe(false); // conservative before the first listing
		await quiet.standSide.listFiles();
		expect(quiet.standSide.isOnlyPeer()).toBe(true);

		const remoteKnows = await connectedPair({}, { repository: fakeRepository([], ['dev-stand', 'dev-van']).repository });
		await remoteKnows.standSide.listFiles();
		expect(remoteKnows.standSide.isOnlyPeer()).toBe(false);

		const localKnows = await connectedPair({ repository: fakeRepository([], ['dev-office', 'dev-van']).repository });
		await localKnows.standSide.listFiles();
		expect(localKnows.standSide.isOnlyPeer()).toBe(false);
	});

	it('turns a serving failure into a server error, without leaking details', async () => {
		const { standSide, officeRepo } = await connectedPair();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		officeRepo.repository.getOutboxSeqs.mockRejectedValueOnce(new Error('secret sql'));

		await expect(standSide.listFiles()).rejects.toMatchObject({ kind: 'server', message: 'The nearby device could not read its changes.' });
		warn.mockRestore();
	});

	it('times out a request the peer never answers', async () => {
		const { standSide, officeRepo } = await connectedPair({ requestTimeoutMs: 5 });
		officeRepo.repository.getOutboxSeqs.mockReturnValueOnce(new Promise(() => {}));
		await expect(standSide.listFiles()).rejects.toMatchObject({ kind: 'timeout' });
	});

	it('runs a full SyncService pull over the channel, including multi-frame packets', async () => {
		const note = JSON.stringify({ notes: '🚲'.repeat(10_000) });
		const officeRepo = fakeRepository([row(1, note), row(2, note)]);
		const standRepo = fakeRepository();
		const pair = linkedPair();
		const [standSide] = await Promise.all([
			WebRtcTransport.connect(pair.linkA, { identity: stand, repository: standRepo.repository }),
			WebRtcTransport.connect(pair.linkB, { identity: office, repository: officeRepo.repository })
		]);
		const applied: OutboxEntry[][] = [];
		const syncRepository = {
			...standRepo.repository,
			getSyncDelta: vi.fn(),
			deletePeerState: vi.fn(),
			pruneStaleOutboxLogs: vi.fn(async () => 0),
			applyRemoteDeltas: vi.fn(async (peerId: string, _name: string, deltas: OutboxEntry[]): Promise<ApplyRemoteResult> => {
				applied.push(deltas);
				const last = deltas[deltas.length - 1].seq;
				standRepo.cursors.set(peerId, last);
				return { applied: deltas.length, blocked: false, blockedAt: null, dropped: 0, lastSyncedSeq: last };
			})
		} as unknown as SyncRepository;

		const state = await new SyncService({ transport: standSide, identity: stand, repository: syncRepository }).syncNow();

		expect(state.error).toBeNull();
		expect(state.lastSummary).toMatchObject({ pulledPackets: 1, appliedDeltas: 2 });
		expect(applied[0].map((entry) => entry.payload)).toEqual([note, note]);
	});
});

describe('WebRtcTransport shutdown', () => {
	it('rejects waiting requests as offline when the channel closes, and reports it once', async () => {
		const onClose = vi.fn();
		const { a, standSide, officeRepo } = await connectedPair({ onClose });
		officeRepo.repository.getOutboxSeqs.mockReturnValueOnce(new Promise(() => {}));

		const listing = standSide.listFiles();
		await new Promise((resolve) => setTimeout(resolve, 1));
		a.emit('close');
		a.emit('close');

		await expect(listing).rejects.toBeInstanceOf(CloudError);
		await expect(listing).rejects.toMatchObject({ kind: 'offline' });
		expect(standSide.isConnected()).toBe(false);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('notices a device that vanished without closing the channel', async () => {
		const { pc, standSide } = await connectedPair();
		pc.fail();
		expect(standSide.isConnected()).toBe(false);
		expect(pc.closed).toBe(true);
	});

	it('fails fast once disconnected', async () => {
		const { standSide } = await connectedPair();
		await standSide.disconnect();
		await expect(standSide.listFiles()).rejects.toMatchObject({ kind: 'offline' });
	});

	it('closes the link on data no honest device sends', async () => {
		const { b, standSide } = await connectedPair();
		await sendFramed(b as unknown as RTCDataChannel, 'not json');
		expect(standSide.isConnected()).toBe(false);
	});
});

describe('protocol messages', () => {
	it.each([
		['a list without a cursor', { t: 'list', rid: 1 }],
		['a negative cursor', { t: 'list', rid: 1, afterSeq: -1 }],
		['a backwards range', { t: 'get', rid: 1, startSeq: 5, endSeq: 1 }],
		['a device id that cannot be a file name', { t: 'hello', protocol: 1, deviceId: '../evil', deviceName: 'x' }],
		['an ok without a usable body', { t: 'ok', rid: 1, body: { files: 'nope' } }],
		['a peer list with an unsafe id', { t: 'peers', devices: ['../evil'] }],
		['an oversized peer list', { t: 'peers', devices: Array(33).fill('dev') }],
		['a signal to an unsafe id', { t: 'signal', to: '../evil', from: 'a', kind: 'o', code: 'x' }],
		['a signal of an unknown kind', { t: 'signal', to: 'a', from: 'b', kind: 'x', code: 'x' }],
		['an oversized signal', { t: 'signal', to: 'a', from: 'b', kind: 'o', code: 'x'.repeat(2001) }],
		['an unknown type', { t: 'surprise' }],
		['null', null]
	])('rejects %s', (_label, message) => {
		expect(parsePeerMessage(JSON.stringify(message))).toBeNull();
	});

	it('cuts seqs into packets, keeping gaps left by restores', () => {
		expect(virtualPacketNames('dev', [1, 2, 5, 9, 10], 2)).toEqual([
			packetFileName({ deviceId: 'dev', startSeq: 1, endSeq: 2 }),
			packetFileName({ deviceId: 'dev', startSeq: 5, endSeq: 9 }),
			packetFileName({ deviceId: 'dev', startSeq: 10, endSeq: 10 })
		]);
		expect(virtualPacketNames('dev', [])).toEqual([]);
	});
});
