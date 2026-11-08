import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStorage } from './cloud/dropboxAuth';
import { describeSync } from './display';
import { SyncController, type SyncControllerState } from './syncController';
import { SyncService } from './syncService';

function memoryStorage(): KeyValueStorage {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key)
	};
}

// Token endpoint succeeds; every other Dropbox call fails as a server error, so a started service never reaches SQLite.
const fetchMock = vi.fn(async (url: string | URL | Request) =>
	String(url).endsWith('/oauth2/token')
		? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
		: new Response('{}', { status: 500 })
);

function setup() {
	const storage = memoryStorage();
	const session = memoryStorage();
	const controller = new SyncController({
		redirectUri: () => 'https://app.example/settings',
		storage,
		sessionStorage: session,
		fetch: fetchMock as unknown as typeof fetch
	});
	controller.init();
	return controller;
}

const input = { appKey: 'key-1', folderPath: 'Shop', deviceName: 'Stand iPad' };

let active: SyncController | null = null;
afterEach(async () => {
	await active?.disconnect(); // stops background polling
	active = null;
});

describe('SyncController', () => {
	it('starts unconfigured and becomes disconnected once an app key is saved', async () => {
		const controller = (active = setup());
		expect(controller.getState().connection).toBe('unconfigured');

		await controller.saveSettings(input);

		expect(controller.getState().connection).toBe('disconnected');
		expect(controller.getSettings()).toEqual({ appKey: 'key-1', folderPath: '/Shop' });
		expect(controller.getIdentity().deviceName).toBe('Stand iPad');
	});

	it('rejects an invalid device name or folder without changing settings', async () => {
		const controller = (active = setup());
		await expect(controller.saveSettings({ ...input, deviceName: ' ' })).rejects.toThrow();
		await expect(controller.saveSettings({ ...input, folderPath: '/a/../b' })).rejects.toThrow();
		expect(controller.getState().connection).toBe('unconfigured');
	});

	it('builds a PKCE authorization URL only after an app key exists', async () => {
		const controller = (active = setup());
		await expect(controller.beginAuthorization()).rejects.toThrow('app key');

		await controller.saveSettings(input);
		const url = new URL(await controller.beginAuthorization());

		expect(url.searchParams.get('client_id')).toBe('key-1');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/settings');
	});

	it('connects after the redirect callback and disconnects again', async () => {
		const controller = (active = setup());
		await controller.saveSettings(input);
		const state = new URL(await controller.beginAuthorization()).searchParams.get('state');

		await controller.completeAuthorization(`https://app.example/settings?code=abc&state=${state}`);
		expect(controller.getState().connection).toBe('connected');

		await controller.disconnect();
		expect(controller.getState().connection).toBe('disconnected');
	});

	it('surfaces a denied authorization as an error and stays disconnected', async () => {
		const controller = (active = setup());
		await controller.saveSettings(input);
		await controller.beginAuthorization();

		await expect(controller.completeAuthorization('https://app.example/settings?error=access_denied')).rejects.toMatchObject({
			kind: 'auth'
		});
		expect(controller.getState().connection).toBe('disconnected');
	});
});

describe('SyncController.requestSync', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function connect(): Promise<SyncController> {
		const controller = (active = setup());
		await controller.saveSettings(input);
		const state = new URL(await controller.beginAuthorization()).searchParams.get('state');
		await controller.completeAuthorization(`https://app.example/settings?code=abc&state=${state}`);
		return controller;
	}

	it('is a safe no-op before Dropbox is connected', async () => {
		const spy = vi.spyOn(SyncService.prototype, 'requestSync');
		const controller = (active = setup());
		controller.requestSync();

		await controller.saveSettings(input); // app key saved, still not authorized
		controller.requestSync();

		expect(spy).not.toHaveBeenCalled();
	});

	it('forwards each request to the service when connected', async () => {
		const controller = await connect();
		const spy = vi.spyOn(SyncService.prototype, 'requestSync').mockImplementation(() => {});

		controller.requestSync();
		controller.requestSync();

		expect(spy).toHaveBeenCalledTimes(2); // the service owns the debounce window
	});

	it('skips requests while offline and resumes once back online', async () => {
		const controller = await connect();
		const spy = vi.spyOn(SyncService.prototype, 'requestSync').mockImplementation(() => {});

		vi.stubGlobal('navigator', { onLine: false });
		controller.requestSync();
		expect(spy).not.toHaveBeenCalled();

		vi.stubGlobal('navigator', { onLine: true });
		controller.requestSync();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe('describeSync', () => {
	const base: SyncControllerState = { status: 'idle', lastSyncedAt: null, lastSummary: null, error: null, connection: 'connected' };

	it('maps connection and status to labels', () => {
		expect(describeSync({ ...base, connection: 'unconfigured' }).label).toBe('Sync off');
		expect(describeSync({ ...base, connection: 'disconnected' }).label).toBe('Not connected');
		expect(describeSync({ ...base, status: 'syncing' })).toEqual({ label: 'Syncing', tone: 'busy' });
		expect(describeSync({ ...base, status: 'offline' }).label).toBe('Offline');
		expect(describeSync({ ...base, status: 'error' }).tone).toBe('error');
		expect(describeSync(base).label).toBe('Up to date');
	});

	it('flags an expired sign-in', () => {
		const expired = { ...base, connection: 'disconnected' as const, error: { kind: 'auth' as const, message: 'x' } };
		expect(describeSync(expired).label).toBe('Sign-in expired');
	});
});
