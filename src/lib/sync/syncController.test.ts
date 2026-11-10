import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEntry, SyncRepository } from '../db/repositories/sync';
import { CloudError } from './cloud/types';
import { describeSync, explainWebDavFailure } from './display';
import { buildPacket, packetFileName } from './packet';
import type { NearbyPairingApi } from './p2p/nearbySession';
import type { PeerLink } from './p2p/pairing';
import type { KeyValueStorage } from './settings';
import { SyncController, type SyncControllerOptions, type SyncControllerState } from './syncController';
import { onRemoteChanges, SyncService } from './syncService';
import type { PeerTransport } from './transport';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key)
	};
}

// Every WebDAV call fails as a server error unless a test says otherwise, so a started service never reaches SQLite.
const serverError = vi.fn(async () => new Response(null, { status: 500 }));

// An empty but working WebDAV server.
const emptyServer = vi.fn(async (_url: string, init: RequestInit) =>
	init.method === 'PROPFIND' ? new Response('<multistatus xmlns="DAV:"></multistatus>', { status: 207 }) : new Response(null, { status: 201 })
);

function fakeRepository(): SyncRepository {
	return {
		getSyncDelta: vi.fn(async () => ({ deltas: [], peer: null })),
		acknowledgeSync: vi.fn(async () => {}),
		getPeerState: vi.fn(async () => null),
		deletePeerState: vi.fn(async () => {}),
		pruneStaleOutboxLogs: vi.fn(async () => 0),
		applyRemoteDeltas: vi.fn(async (_peer: string, _name: string, deltas: OutboxEntry[]) => ({
			applied: deltas.length,
			blocked: false,
			blockedAt: null,
			dropped: 0,
			lastSyncedSeq: deltas[deltas.length - 1].seq
		}))
	} as unknown as SyncRepository;
}

const webdav = { webdavUrl: 'https://nas.example/dav', username: 'shop', password: 'pw', folderPath: 'Shop' };

let active: SyncController | null = null;
function setup(options: SyncControllerOptions = {}): SyncController {
	const trust = { getTrustedPeers: vi.fn(async () => []), trustPeer: vi.fn(async () => {}), forgetPeer: vi.fn(async () => {}) };
	const controller = new SyncController({ storage: memoryStorage(), fetch: serverError as unknown as typeof fetch, trust, ...options });
	controller.init();
	active = controller;
	return controller;
}

afterEach(() => {
	active?.disconnectWebDav(); // stops background polling
	active?.nearby.end();
	active = null;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	serverError.mockClear();
	emptyServer.mockClear();
});

describe('SyncController WebDAV settings', () => {
	it('starts unconfigured and connects once details are saved', async () => {
		const controller = setup();
		expect(controller.getState().connection).toBe('unconfigured');

		await controller.saveWebDav(webdav);

		expect(controller.getState().connection).toBe('connected');
		expect(controller.getSettings()).toEqual({ ...webdav, folderPath: '/Shop' });
	});

	it('is not connected without a password', async () => {
		const controller = setup();
		await controller.saveWebDav({ ...webdav, password: '' });
		expect(controller.getState().connection).toBe('disconnected');
	});

	it('resets pull cursors only when the server, account or folder changes after setup', async () => {
		const reset = vi.fn(async () => {});
		const controller = setup({ resetPullCursors: reset });

		await controller.saveWebDav(webdav); // first-time setup
		await controller.saveWebDav({ ...webdav, password: 'new' }); // same folder
		expect(reset).not.toHaveBeenCalled();

		await controller.saveWebDav({ ...webdav, folderPath: 'Other' });
		expect(reset).toHaveBeenCalledTimes(1);
		await controller.saveWebDav({ ...webdav, folderPath: 'Other', username: 'other' });
		expect(reset).toHaveBeenCalledTimes(2);
		await controller.saveWebDav({ ...webdav, folderPath: 'Other', username: 'other', webdavUrl: 'https://else.example/dav' });
		expect(reset).toHaveBeenCalledTimes(3);
	});

	it('rejects invalid details without changing anything', async () => {
		const controller = setup();
		await expect(controller.saveWebDav({ ...webdav, webdavUrl: 'http://nas.local/' })).rejects.toThrow(/https/);
		await expect(controller.saveWebDav({ ...webdav, folderPath: '/a/../b' })).rejects.toThrow();
		expect(controller.getState().connection).toBe('unconfigured');
	});

	it('forgets only the password on disconnect', async () => {
		const controller = setup();
		await controller.saveWebDav(webdav);

		controller.disconnectWebDav();

		expect(controller.getState().connection).toBe('disconnected');
		expect(controller.getSettings()).toEqual({ ...webdav, folderPath: '/Shop', password: '' });
	});

	it('stops retrying rejected credentials, so the account is not locked out', async () => {
		const unauthorized = vi.fn(async () => new Response(null, { status: 401 }));
		const controller = setup({ fetch: unauthorized as unknown as typeof fetch });

		await controller.saveWebDav(webdav);

		await vi.waitFor(() => expect(controller.getState().connection).toBe('disconnected'));
		expect(controller.getState().error?.kind).toBe('auth');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(unauthorized).toHaveBeenCalledTimes(1);
	});

	it('removes an old Dropbox token at startup', () => {
		const storage = memoryStorage({ 'bmp.sync.dropbox.tokens': '{"refreshToken":"rt"}' });
		setup({ storage });
		expect(storage.getItem('bmp.sync.dropbox.tokens')).toBeNull();
	});

	it('renaming the device keeps WebDAV running', async () => {
		const storage = memoryStorage();
		const controller = setup({ storage });
		await controller.saveWebDav(webdav);

		controller.saveDeviceName('Stand iPad');

		expect(controller.getIdentity().deviceName).toBe('Stand iPad');
		expect(controller.getState().connection).toBe('connected');
		expect(() => controller.saveDeviceName(' ')).toThrow();
	});

	it('tests details without saving them', async () => {
		const controller = setup({ fetch: emptyServer as unknown as typeof fetch });

		await controller.testWebDav(webdav);

		expect(emptyServer.mock.calls.map(([, init]) => init.method)).toEqual(['MKCOL', 'PROPFIND']);
		expect(controller.getSettings().webdavUrl).toBe('');
		expect(controller.getState().connection).toBe('unconfigured');
	});
});

describe('SyncController.requestSync', () => {
	it('is a safe no-op before WebDAV is set up', async () => {
		const spy = vi.spyOn(SyncService.prototype, 'requestSync');
		const controller = setup();
		controller.requestSync();
		await controller.saveWebDav({ ...webdav, password: '' });
		controller.requestSync();
		expect(spy).not.toHaveBeenCalled();
	});

	it('forwards each request while connected and skips them offline', async () => {
		const controller = setup();
		await controller.saveWebDav(webdav);
		const spy = vi.spyOn(SyncService.prototype, 'requestSync').mockImplementation(() => {});

		controller.requestSync();
		expect(spy).toHaveBeenCalledTimes(1);

		vi.stubGlobal('navigator', { onLine: false });
		controller.requestSync();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe('SyncController nearby link', () => {
	const peerIdentity = { deviceId: 'dev-office', deviceName: 'Office Mac' };
	const row: OutboxEntry = { seq: 1, id: 'evt-1', entity_type: 'customer', entity_id: 'c1', action: 'INSERT', payload: '{}', created_at: '2026-11-07T10:00:00.000Z' };

	function fakePeer(listFiles: PeerTransport['listFiles'], downloadFile: PeerTransport['downloadFile'] = async () => '') {
		let closeLink = () => {};
		const transport: PeerTransport = {
			kind: 'peer',
			id: 'webrtc:dev-office',
			displayName: 'Office Mac',
			peerDeviceId: 'dev-office',
			isConnected: () => true,
			disconnect: async () => {},
			isOnlyPeer: () => true,
			sendMesh: () => {},
			listFiles,
			downloadFile
		};
		const pairing = {
			start: vi.fn(),
			join: vi.fn(async () => ({ payload: 'ANSWER', link: {} as PeerLink })),
			connect: vi.fn(async (_link: PeerLink, options: { onClose?: () => void }) => {
				closeLink = options.onClose ?? closeLink;
				return transport;
			})
		} as unknown as NearbyPairingApi;
		return { pairing, closeLink: () => closeLink() };
	}

	const emptyPeer = () => fakePeer(async () => []);

	it('counts as connected with no WebDAV, and goes back when the link drops', async () => {
		const { pairing, closeLink } = emptyPeer();
		const controller = setup({ pairing, repository: fakeRepository() });

		await controller.nearby.join('OFFER');
		await vi.waitFor(() => expect(controller.getState().peers).toMatchObject([{ deviceName: 'Office Mac', linked: true }]));
		expect(controller.getState().connection).toBe('connected');

		closeLink();
		expect(controller.getState().connection).toBe('unconfigured');
		expect(controller.getState().nearby).toMatchObject({ phase: 'idle', message: expect.stringContaining('Pair again') });
	});

	it('reports either path failing while the other is healthy', async () => {
		const { pairing } = fakePeer(async () => {
			throw new CloudError('server', 'peer broke');
		});
		const controller = setup({ pairing, repository: fakeRepository(), fetch: emptyServer as unknown as typeof fetch });
		await controller.saveWebDav(webdav);
		await controller.syncNow(); // let WebDAV's first cycle release the sync lock

		await controller.nearby.join('OFFER');
		await vi.waitFor(() => expect(controller.getState().error?.message).toBe('peer broke'));
		expect(controller.getState().status).toBe('error');
	});

	it('keeps the last sync time after the link ends', async () => {
		const { pairing, closeLink } = emptyPeer();
		const controller = setup({ pairing, repository: fakeRepository() });
		await controller.nearby.join('OFFER');
		await vi.waitFor(() => expect(controller.getState().lastSyncedAt).not.toBeNull());

		closeLink();

		expect(controller.getState().lastSyncedAt).not.toBeNull();
	});

	it('reloads open screens once per batch of received changes, not on every status change', async () => {
		const packet = buildPacket(peerIdentity, [row]);
		let served = false;
		const { pairing } = fakePeer(
			async () => {
				if (served) return [];
				served = true;
				return [{ name: packetFileName(packet), size: 0, modifiedAt: '' }];
			},
			async () => JSON.stringify(packet)
		);
		const controller = setup({ pairing, repository: fakeRepository(), fetch: emptyServer as unknown as typeof fetch });
		await controller.saveWebDav(webdav);
		await controller.syncNow(); // let WebDAV's first cycle release the sync lock
		const refresh = vi.fn();
		onRemoteChanges(controller, refresh);

		await controller.nearby.join('OFFER');
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

		await controller.syncNow();
		await controller.syncNow();
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe('describeSync', () => {
	const base: SyncControllerState = {
		status: 'idle',
		lastSyncedAt: null,
		lastSummary: null,
		error: null,
		connection: 'connected',
		nearby: { phase: 'idle', message: null },
		peers: []
	};

	it('maps connection and status to labels', () => {
		expect(describeSync({ ...base, connection: 'unconfigured' }).label).toBe('Sync off');
		expect(describeSync({ ...base, connection: 'disconnected' }).label).toBe('Not connected');
		expect(describeSync({ ...base, status: 'syncing' })).toEqual({ label: 'Syncing', tone: 'busy' });
		expect(describeSync({ ...base, status: 'offline' }).label).toBe('Offline');
		expect(describeSync({ ...base, status: 'error' }).tone).toBe('error');
		expect(describeSync(base).label).toBe('Up to date');
	});

	it('flags rejected credentials', () => {
		const rejected = { ...base, connection: 'disconnected' as const, error: { kind: 'auth' as const, message: 'x' } };
		expect(describeSync(rejected).label).toBe('Sign-in rejected');
	});
});

describe('explainWebDavFailure', () => {
	const origin = 'https://app.example';

	it('names the likely cause of an unreachable server, including this app\'s origin', () => {
		expect(explainWebDavFailure(new CloudError('offline', 'Network request failed.'), origin)).toContain(origin);
	});

	it('explains rejected credentials and wrong addresses', () => {
		expect(explainWebDavFailure(new CloudError('auth', 'x'), origin)).toContain('app password');
		expect(explainWebDavFailure(new CloudError('not_found', 'x'), origin)).toContain('Check the address');
	});

	it('passes through anything else', () => {
		expect(explainWebDavFailure(new CloudError('server', 'answered 500'), origin)).toBe('answered 500');
		expect(explainWebDavFailure(new Error('Enter the full address'), origin)).toBe('Enter the full address');
	});
});
