import { describe, expect, it, vi } from 'vitest';
import type { PeerTransport } from '../transport';
import type { TrustedPeer } from '../../db/repositories/sync';
import { NearbySession, type NearbyPairingApi } from './nearbySession';
import type { PeerLink } from './pairing';
import type { MeshMessage } from './protocol';
import type { WebRtcTransportOptions } from './webrtcTransport';

const fakeLink = () => ({ pc: { close: vi.fn() }, channel: {} }) as unknown as PeerLink & { pc: { close: ReturnType<typeof vi.fn> } };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const fakeTrust = (saved: TrustedPeer[] = []) => ({
	getTrustedPeers: vi.fn(async () => saved),
	trustPeer: vi.fn(async () => {}),
	forgetPeer: vi.fn(async () => {})
});

const fakeTransport = (peerDeviceId: string, displayName = peerDeviceId) =>
	({ peerDeviceId, displayName, disconnect: vi.fn(async () => {}), sendMesh: vi.fn() }) as unknown as PeerTransport & {
		disconnect: ReturnType<typeof vi.fn>;
		sendMesh: ReturnType<typeof vi.fn>;
	};

function setup() {
	const link = fakeLink();
	const accept = vi.fn(async () => {});
	const connection = deferred<PeerTransport>();
	const connect = vi.fn((_link: PeerLink, _options: WebRtcTransportOptions) => connection.promise);
	const start = vi.fn(async () => ({ payload: 'OFFER', link, accept }));
	const join = vi.fn(async () => ({ payload: 'ANSWER', link }));
	const onConnected = vi.fn();
	const onEnded = vi.fn();
	const trust = fakeTrust();
	const session = new NearbySession({
		identity: () => ({ deviceId: 'me', deviceName: 'Me' }),
		onChange: () => {},
		onConnected,
		onEnded,
		pairing: { start, join, connect } as unknown as NearbyPairingApi,
		trust
	});
	const transport = fakeTransport('dev-office', 'Office Mac');
	const linkClosed = () => connect.mock.calls[0][1].onClose?.();
	return { session, link, accept, connection, connect, start, join, onConnected, onEnded, transport, linkClosed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('NearbySession, first device', () => {
	it('shows its code, then connects after the reply', async () => {
		const { session, accept, connection, onConnected, transport } = setup();
		await session.offer();
		expect(session.getState()).toEqual({ phase: 'offering', code: 'OFFER' });

		await session.acceptAnswer('REPLY');
		expect(accept).toHaveBeenCalledWith('REPLY');
		expect(session.getState()).toEqual({ phase: 'connecting' });

		connection.resolve(transport);
		await flush();
		expect(session.getState()).toEqual({ phase: 'idle', message: null });
		expect(session.getPeers()).toEqual([{ deviceId: 'dev-office', deviceName: 'Office Mac', linked: true }]);
		expect(onConnected).toHaveBeenCalledWith(transport);
	});

	it('stays on the same step after an invalid reply, so it can be scanned again', async () => {
		const { session, accept, connect } = setup();
		await session.offer();
		accept.mockRejectedValueOnce(new Error('bad code'));

		await expect(session.acceptAnswer('junk')).rejects.toThrow('bad code');

		expect(session.getState()).toEqual({ phase: 'offering', code: 'OFFER' });
		expect(connect).not.toHaveBeenCalled();
	});

	it('ignores a second scan of the same reply', async () => {
		const { session, accept } = setup();
		await session.offer();
		await Promise.all([session.acceptAnswer('REPLY'), session.acceptAnswer('REPLY')]);
		expect(accept).toHaveBeenCalledTimes(1);
	});

	it('closes the connection when cancelled while preparing', async () => {
		const { session, link, start, accept } = setup();
		const pending = deferred<{ payload: string; link: PeerLink; accept: typeof accept }>();
		start.mockReturnValueOnce(pending.promise as never);

		const offering = session.offer();
		session.end();
		pending.resolve({ payload: 'OFFER', link, accept });
		await offering;

		expect(link.pc.close).toHaveBeenCalled();
		expect(session.getState()).toEqual({ phase: 'idle', message: null });
	});
});

describe('NearbySession, second device', () => {
	it('shows its reply and waits to be connected', async () => {
		const { session, join, connect } = setup();
		await session.join('OFFER');
		expect(join).toHaveBeenCalledWith('OFFER');
		expect(session.getState()).toEqual({ phase: 'answering', code: 'ANSWER' });
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it('returns to idle on an invalid code, and says so to the caller', async () => {
		const { session, join } = setup();
		join.mockRejectedValueOnce(new Error('not valid'));
		await expect(session.join('junk')).rejects.toThrow('not valid');
		expect(session.getState()).toEqual({ phase: 'idle', message: null });
	});
});

describe('NearbySession link lifetime', () => {
	async function connected() {
		const context = setup();
		await context.session.join('OFFER');
		context.connection.resolve(context.transport);
		await flush();
		return context;
	}

	it('explains a failed connection', async () => {
		const { session, connection } = setup();
		await session.join('OFFER');
		connection.reject(new Error('Check both are on the same Wi-Fi.'));
		await flush();
		expect(session.getState()).toEqual({ phase: 'idle', message: 'Check both are on the same Wi-Fi.' });
	});

	it('does not announce a dropped link for a connection that never finished', async () => {
		const { session, linkClosed, onEnded } = setup();
		await session.join('OFFER');
		linkClosed();
		expect(onEnded).not.toHaveBeenCalled();
		expect(session.getState()).toMatchObject({ phase: 'answering' });
	});

	it('tells the user when the other device goes away', async () => {
		const { session, linkClosed, onEnded } = await connected();
		linkClosed();
		expect(session.getState()).toMatchObject({ phase: 'idle', message: expect.stringContaining('Pair again') });
		expect(onEnded).toHaveBeenCalledTimes(1);
	});

	it('disconnects when asked, once', async () => {
		const { session, transport, linkClosed, onEnded } = await connected();
		session.end();
		linkClosed();
		expect(transport.disconnect).toHaveBeenCalledTimes(1);
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(session.getState()).toEqual({ phase: 'idle', message: null });
	});

	it('drops a connection that finishes after being cancelled', async () => {
		const { session, connection, transport, onConnected } = setup();
		await session.join('OFFER');
		session.end();
		connection.resolve(transport);
		await flush();
		expect(transport.disconnect).toHaveBeenCalled();
		expect(onConnected).not.toHaveBeenCalled();
	});

	it('keeps existing links while pairing another device, and when that is cancelled', async () => {
		const { session, transport, onEnded } = await connected();
		await session.offer();
		expect(session.getState()).toMatchObject({ phase: 'offering' });
		session.cancel();
		expect(transport.disconnect).not.toHaveBeenCalled();
		expect(onEnded).not.toHaveBeenCalled();
		expect(session.getPeers()).toMatchObject([{ linked: true }]);
	});

	it('remembers a device after a QR pairing, by the fingerprint in the code', async () => {
		const { session, connection, transport } = setup();
		const trust = (session as unknown as { trust: ReturnType<typeof fakeTrust> }).trust;
		await session.join(code('FP-OFFICE'));
		connection.resolve(transport);
		await flush();
		expect(trust.trustPeer).toHaveBeenCalledWith({ deviceId: 'dev-office', deviceName: 'Office Mac', fingerprint: 'FP-OFFICE' });
	});

	it('keeps a remembered device as not linked after its link drops', async () => {
		const { session, linkClosed } = await connected();
		linkClosed();
		expect(session.getPeers()).toMatchObject([{ deviceId: 'dev-office', linked: false }]);
	});

	it('forgets a device and drops its link', async () => {
		const { session, transport, onEnded } = await connected();
		await session.forget('dev-office');
		expect(transport.disconnect).toHaveBeenCalled();
		expect(onEnded).toHaveBeenCalledWith('dev-office');
		expect(session.getPeers()).toEqual([]);
	});
});

const code = (fingerprint: string) => `BMP1|o|ufrag|password|${fingerprint}|1.2.3.4#5`;

describe('NearbySession mesh recovery', () => {
	const remembered: TrustedPeer[] = [
		{ deviceId: 'z-phone', deviceName: 'Phone', fingerprint: 'FP-Z' },
		{ deviceId: 'a-desk', deviceName: 'Desk', fingerprint: 'FP-A' }
	];

	// This device ('m-me') linked by QR to 'hub', and able to connect to whatever `next` holds.
	async function linkedToHub() {
		const hub = fakeTransport('hub');
		const next: Array<PeerTransport | Promise<PeerTransport>> = [hub];
		const accept = vi.fn(async () => {});
		const start = vi.fn(async () => ({ payload: code('FP-ME'), link: fakeLink(), accept }));
		const join = vi.fn(async () => ({ payload: 'REPLY', link: fakeLink() }));
		const connect = vi.fn(async (_link: PeerLink, _options: WebRtcTransportOptions) => next.shift()!);
		const onConnected = vi.fn();
		const session = new NearbySession({
			identity: () => ({ deviceId: 'm-me', deviceName: 'Me' }),
			onChange: () => {},
			onConnected,
			onEnded: () => {},
			pairing: { start, join, connect } as unknown as NearbyPairingApi,
			trust: fakeTrust(remembered)
		});
		await session.loadTrusted();
		await session.join(code('FP-HUB'));
		await flush();
		const fromHub = async (message: MeshMessage) => {
			connect.mock.calls[0][1].onMesh!(message);
			await flush();
		};
		return { session, hub, next, accept, start, join, onConnected, fromHub };
	}

	const signals = (transport: ReturnType<typeof fakeTransport>) => transport.sendMesh.mock.calls.map(([message]) => message).filter((message) => message.t === 'signal');
	const linked = (session: NearbySession) => session.getPeers().filter((peer) => peer.linked).map((peer) => peer.deviceId);

	it('tells a new link who else it is linked to', async () => {
		const { hub } = await linkedToHub();
		expect(hub.sendMesh).toHaveBeenCalledWith({ t: 'peers', devices: ['hub'] });
	});

	it('offers to a remembered device it can reach, and accepts only an answer with the saved fingerprint', async () => {
		const { session, hub, next, accept, fromHub, onConnected } = await linkedToHub();
		const phone = fakeTransport('z-phone');
		const connecting = deferred<PeerTransport>();
		next.push(connecting.promise);

		await fromHub({ t: 'peers', devices: ['hub', 'z-phone', 'm-me'] });
		expect(signals(hub)).toEqual([{ t: 'signal', to: 'z-phone', from: 'm-me', kind: 'o', code: code('FP-ME') }]);

		await fromHub({ t: 'signal', to: 'm-me', from: 'z-phone', kind: 'a', code: code('FP-EVIL') });
		expect(accept).not.toHaveBeenCalled();

		await fromHub({ t: 'signal', to: 'm-me', from: 'z-phone', kind: 'a', code: code('FP-Z') });
		expect(accept).toHaveBeenCalledWith(code('FP-Z'));

		connecting.resolve(phone);
		await flush();
		expect(onConnected).toHaveBeenCalledWith(phone);
		expect(linked(session)).toContain('z-phone');
	});

	it('acts on a device list that arrives while the new link is still being saved', async () => {
		const hub = fakeTransport('hub');
		const saving = deferred<void>();
		const trust = { ...fakeTrust(remembered), trustPeer: vi.fn(() => saving.promise) };
		const start = vi.fn(async () => ({ payload: code('FP-ME'), link: fakeLink(), accept: vi.fn(async () => {}) }));
		const connect = vi.fn(async (_link: PeerLink, _options: WebRtcTransportOptions) => (connect.mock.calls.length === 1 ? hub : fakeTransport('z-phone')));
		const session = new NearbySession({
			identity: () => ({ deviceId: 'm-me', deviceName: 'Me' }),
			onChange: () => {},
			onConnected: () => {},
			onEnded: () => {},
			pairing: { start, join: vi.fn(async () => ({ payload: 'REPLY', link: fakeLink() })), connect } as unknown as NearbyPairingApi,
			trust
		});
		await session.loadTrusted();
		await session.join(code('FP-HUB'));
		await flush(); // linked to the hub at the transport level, but the hub is still being remembered

		connect.mock.calls[0][1].onMesh!({ t: 'peers', devices: ['hub', 'z-phone', 'm-me'] });
		await flush();
		expect(start).not.toHaveBeenCalled(); // no link to relay through yet

		saving.resolve();
		await flush();
		expect(start).toHaveBeenCalledTimes(1); // the list that came early is acted on now
	});

	it('abandons a stale attempt and tries again at once when the device is listed again', async () => {
		const { session, start, next, fromHub } = await linkedToHub();
		const stale = deferred<PeerTransport>();
		next.push(stale.promise, fakeTransport('z-phone'));

		await fromHub({ t: 'peers', devices: ['z-phone'] });
		expect(start).toHaveBeenCalledTimes(1);

		await fromHub({ t: 'peers', devices: ['z-phone', 'hub'] }); // the stale attempt is still waiting out its timeout
		await flush();
		expect(start).toHaveBeenCalledTimes(2);
		expect(linked(session)).toContain('z-phone');

		stale.reject(new Error('timed out')); // must not raise once nobody is waiting for it
		await flush();
	});

	it('tries once more when the device is listed again during a failing attempt', async () => {
		const { session, start, next, fromHub } = await linkedToHub();
		const doomed = deferred<PeerTransport>();
		next.push(doomed.promise, fakeTransport('z-phone'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		await fromHub({ t: 'peers', devices: ['z-phone'] });
		doomed.reject(new Error('timed out'));
		await flush();
		expect(start).toHaveBeenCalledTimes(1); // nothing new has been said, so no retry

		await fromHub({ t: 'peers', devices: ['z-phone', 'hub'] });
		await flush();
		expect(start).toHaveBeenCalledTimes(2);
		expect(linked(session)).toContain('z-phone');
	});

	it('does not keep retrying a device nobody has mentioned again', async () => {
		const { start, next, fromHub } = await linkedToHub();
		const doomed = deferred<PeerTransport>();
		next.push(doomed.promise);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		await fromHub({ t: 'peers', devices: ['z-phone'] });
		doomed.reject(new Error('timed out'));
		await flush();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('leaves the offer to a device with a lower id', async () => {
		const { start, fromHub } = await linkedToHub();
		await fromHub({ t: 'peers', devices: ['a-desk'] });
		expect(start).not.toHaveBeenCalled();
	});

	it('never links to a device that was not paired by QR', async () => {
		const { start, fromHub } = await linkedToHub();
		await fromHub({ t: 'peers', devices: ['z-stranger'] });
		expect(start).not.toHaveBeenCalled();
	});

	it('answers an offer whose fingerprint matches the saved one', async () => {
		const { session, hub, next, join, fromHub } = await linkedToHub();
		next.push(fakeTransport('a-desk'));
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-A') });
		expect(join).toHaveBeenCalledWith(code('FP-A'));
		expect(signals(hub)).toEqual([{ t: 'signal', to: 'a-desk', from: 'm-me', kind: 'a', code: 'REPLY' }]);
		expect(linked(session)).toContain('a-desk');
	});

	it('ignores an offer with a different fingerprint, or from a stranger', async () => {
		const { join, fromHub } = await linkedToHub();
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-EVIL') });
		await fromHub({ t: 'signal', to: 'm-me', from: 'z-stranger', kind: 'o', code: code('FP-Z') });
		expect(join).toHaveBeenCalledTimes(1); // only the QR pairing with the hub
	});

	it('drops a relayed link whose device is not the one it expected', async () => {
		const { session, next, fromHub } = await linkedToHub();
		const impostor = fakeTransport('a-other');
		next.push(impostor);
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-A') });
		expect(impostor.disconnect).toHaveBeenCalled();
		expect(linked(session)).not.toContain('a-other');
	});

	it('passes along a signal meant for another linked device', async () => {
		const { hub, next, fromHub } = await linkedToHub();
		const desk = fakeTransport('a-desk');
		next.push(desk);
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-A') });

		const forHub = { t: 'signal', to: 'a-desk', from: 'hub', kind: 'a', code: 'x' } as const;
		await fromHub(forHub);
		expect(desk.sendMesh).toHaveBeenCalledWith(forHub);
		expect(signals(hub)).not.toContainEqual(forHub);
	});

	it('replaces a stale link when the other device offers again', async () => {
		const { session, next, fromHub } = await linkedToHub();
		const stale = fakeTransport('a-desk');
		next.push(stale, fakeTransport('a-desk'));
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-A') });
		await fromHub({ t: 'signal', to: 'm-me', from: 'a-desk', kind: 'o', code: code('FP-A') });
		expect(stale.disconnect).toHaveBeenCalled();
		expect(linked(session).filter((id) => id === 'a-desk')).toHaveLength(1);
	});
});
