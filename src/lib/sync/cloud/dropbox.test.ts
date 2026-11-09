import { describe, expect, it, vi } from 'vitest';
import { DropboxAdapter } from './dropbox';
import { DropboxAuth, type KeyValueStorage } from './dropboxAuth';
import { CloudError } from './types';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key)
	};
}

const TOKENS_KEY = 'bmp.sync.dropbox.tokens';
const validTokens = JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 });

function setup(fetchImpl: typeof fetch, tokens = validTokens) {
	const storage = memoryStorage(tokens ? { [TOKENS_KEY]: tokens } : {});
	const auth = new DropboxAuth({
		appKey: 'app-key',
		redirectUri: 'https://app.example/callback',
		storage,
		sessionStorage: memoryStorage(),
		fetch: fetchImpl
	});
	return { auth, storage, adapter: new DropboxAdapter(auth, { fetch: fetchImpl }) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });

describe('DropboxAdapter', () => {
	it('has an id per app key, so a new key does not inherit upload progress', () => {
		expect(setup(vi.fn() as unknown as typeof fetch).adapter.id).toBe('dropbox:app-key');
	});

	it('uploads with add mode and the bearer token', async () => {
		const fetchMock = vi.fn(async () => json({}));
		const { adapter } = setup(fetchMock as unknown as typeof fetch);

		await adapter.uploadFile('/sync', 'a.json', '{"x":1}');

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://content.dropboxapi.com/2/files/upload');
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer at-1');
		expect(JSON.parse(headers['Dropbox-API-Arg'])).toEqual({
			path: '/sync/a.json',
			mode: 'add',
			autorename: false,
			mute: true
		});
		expect(init.body).toBe('{"x":1}');
	});

	it('maps a path conflict on upload to a conflict error', async () => {
		const fetchMock = vi.fn(async () => json({ error_summary: 'path/conflict/file/..' }, 409));
		const { adapter } = setup(fetchMock as unknown as typeof fetch);

		await expect(adapter.uploadFile('/sync', 'a.json', '{}')).rejects.toMatchObject({ kind: 'conflict' });
	});

	it('treats an existing folder as success', async () => {
		const fetchMock = vi.fn(async () => json({ error_summary: 'path/conflict/folder/..' }, 409));
		const { adapter } = setup(fetchMock as unknown as typeof fetch);

		await expect(adapter.ensureFolder('/sync')).resolves.toBeUndefined();
	});

	it('lists files across pages and returns [] for a missing folder', async () => {
		const pages = [
			json({ entries: [{ '.tag': 'file', name: 'a.json', size: 1 }, { '.tag': 'folder', name: 'sub' }], cursor: 'c1', has_more: true }),
			json({ entries: [{ '.tag': 'file', name: 'b.json', size: 2 }], cursor: 'c2', has_more: false })
		];
		const { adapter } = setup((async () => pages.shift()!) as unknown as typeof fetch);
		expect((await adapter.listFiles('/sync')).map((file) => file.name)).toEqual(['a.json', 'b.json']);

		const missing = setup((async () => json({ error_summary: 'path/not_found/..' }, 409)) as unknown as typeof fetch);
		expect(await missing.adapter.listFiles('/sync')).toEqual([]);
	});

	it('refreshes the token once on 401 and retries', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes('oauth2/token')) return json({ access_token: 'at-2', expires_in: 14400 });
			const auth = (init?.headers as Record<string, string>).Authorization;
			return auth === 'Bearer at-2' ? new Response('file body') : new Response('expired', { status: 401 });
		});
		const { adapter, storage } = setup(fetchMock as unknown as typeof fetch);

		expect(await adapter.downloadFile('/sync', 'a.json')).toBe('file body');
		expect(JSON.parse(storage.getItem(TOKENS_KEY)!)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1' });
	});

	it('reports auth failure and signs out when the refresh token is rejected', async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url.includes('oauth2/token') ? json({ error: 'invalid_grant' }, 400) : new Response('expired', { status: 401 })
		);
		const { adapter, auth } = setup(fetchMock as unknown as typeof fetch);

		await expect(adapter.downloadFile('/sync', 'a.json')).rejects.toMatchObject({ kind: 'auth' });
		expect(auth.isConnected()).toBe(false);
	});

	it('reports offline on network failure, rate limits with Retry-After, and server errors', async () => {
		const offline = setup((async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch);
		await expect(offline.adapter.listFiles('/sync')).rejects.toMatchObject({ kind: 'offline' });

		const limited = setup((async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } })) as unknown as typeof fetch);
		await expect(limited.adapter.listFiles('/sync')).rejects.toMatchObject({ kind: 'rate_limit', options: { retryAfterMs: 7000 } });

		const broken = setup((async () => new Response('', { status: 503 })) as unknown as typeof fetch);
		await expect(broken.adapter.listFiles('/sync')).rejects.toBeInstanceOf(CloudError);
	});

	it('requires a connection before any request', async () => {
		const fetchMock = vi.fn();
		const { adapter } = setup(fetchMock as unknown as typeof fetch, '');

		await expect(adapter.listFiles('/sync')).rejects.toMatchObject({ kind: 'auth' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('DropboxAuth', () => {
	it('builds a PKCE authorization URL and exchanges the returned code', async () => {
		const fetchMock = vi.fn(async () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 14400 }));
		const { auth } = setup(fetchMock as unknown as typeof fetch, '');

		const url = new URL(await auth.createAuthorizationUrl());
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('token_access_type')).toBe('offline');

		await auth.completeAuthorization(`https://app.example/callback?code=abc&state=${url.searchParams.get('state')}`);

		const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
		expect(body.get('code')).toBe('abc');
		expect(body.get('code_verifier')).toBeTruthy();
		expect(auth.isConnected()).toBe(true);
	});

	it('rejects a callback with a mismatched state', async () => {
		const { auth } = setup(vi.fn() as unknown as typeof fetch, '');
		await auth.createAuthorizationUrl();

		await expect(auth.completeAuthorization('https://app.example/callback?code=abc&state=forged')).rejects.toMatchObject({
			kind: 'auth'
		});
		expect(auth.isConnected()).toBe(false);
	});
});
