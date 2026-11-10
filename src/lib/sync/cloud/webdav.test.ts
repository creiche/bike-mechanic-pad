import { describe, expect, it, vi } from 'vitest';
import { normalizeWebDavUrl, WebDavTransport } from './webdav';

const BASE = 'https://nas.example/remote.php/dav/files/shop';
const PACKET = 'dev-1_000000000001_000000000002.json';

type Call = { url: string; init: RequestInit; headers: Record<string, string> };

function setup(respond: (call: Call) => Response, config: Partial<{ username: string; password: string }> = {}) {
	const calls: Call[] = [];
	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		const call = { url, init, headers: init.headers as Record<string, string> };
		calls.push(call);
		return respond(call);
	});
	const transport = new WebDavTransport(
		{ url: `${BASE}/`, username: 'shop', password: 'secret-pass', ...config },
		{ fetch: fetchMock as unknown as typeof fetch }
	);
	return { transport, calls };
}

const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });
const multistatus = (xml: string) => new Response(xml, { status: 207 });

describe('normalizeWebDavUrl', () => {
	it('trims, drops trailing slashes and any query', () => {
		expect(normalizeWebDavUrl('  https://nas.example/dav/?x=1#y ')).toBe('https://nas.example/dav');
		expect(normalizeWebDavUrl('https://nas.example/')).toBe('https://nas.example');
	});

	it('allows plain http only to this machine', () => {
		expect(normalizeWebDavUrl('http://localhost:8080/dav')).toBe('http://localhost:8080/dav');
		expect(normalizeWebDavUrl('http://127.0.0.1:8080/dav')).toBe('http://127.0.0.1:8080/dav');
		expect(() => normalizeWebDavUrl('http://nas.local/dav')).toThrow(/https/);
	});

	it.each([
		['junk', 'not a url'],
		['another protocol', 'ftp://nas.example/dav'],
		['embedded credentials', 'https://me:pw@nas.example/dav']
	])('rejects %s', (_label, input) => {
		expect(() => normalizeWebDavUrl(input)).toThrow();
	});
});

describe('WebDavTransport identity and auth', () => {
	it('tracks progress per server and account', () => {
		const { transport } = setup(() => status(201));
		expect(transport.kind).toBe('relay');
		expect(transport.id).toBe(`webdav:shop@${BASE}`);
		expect(transport.displayName).toBe('nas.example');
		expect(setup(() => status(201), { username: 'other' }).transport.id).not.toBe(transport.id);
	});

	it('sends UTF-8 basic auth and never browser cookies', async () => {
		const { transport, calls } = setup(() => status(200), { username: 'jörg', password: 'pä55🚲' });
		await transport.downloadFile('/sync', PACKET);

		const encoded = calls[0].headers.Authorization.replace('Basic ', '');
		expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))).toBe('jörg:pä55🚲');
		expect(calls[0].init.credentials).toBe('omit');
	});

	it('refuses a username basic auth cannot represent', () => {
		expect(() => setup(() => status(200), { username: 'a:b' })).toThrow(/cannot contain/);
	});
});

describe('WebDavTransport.ensureFolder', () => {
	it('creates each level from the top, tolerating levels that exist', async () => {
		const { transport, calls } = setup((call) => (call.url.endsWith('/Shop/') ? status(405) : status(201)));

		await transport.ensureFolder('/Shop/Bike Sync');

		expect(calls.map((call) => call.init.method)).toEqual(['MKCOL', 'MKCOL']);
		expect(calls.map((call) => call.url)).toEqual([`${BASE}/Shop/`, `${BASE}/Shop/Bike%20Sync/`]);
	});

	it('does not repeat itself on every poll', async () => {
		const { transport, calls } = setup(() => status(201));
		await transport.ensureFolder('/sync');
		await transport.ensureFolder('/sync');
		expect(calls).toHaveLength(1);
	});

	it('reports bad credentials and does not remember the folder', async () => {
		let code = 401;
		const { transport, calls } = setup(() => status(code));
		await expect(transport.ensureFolder('/sync')).rejects.toMatchObject({ kind: 'auth' });

		code = 201;
		await transport.ensureFolder('/sync');
		expect(calls).toHaveLength(2);
	});
});

describe('WebDavTransport.uploadFile', () => {
	it('never overwrites', async () => {
		const { transport, calls } = setup(() => status(201));

		await transport.uploadFile('/sync', PACKET, '{"x":1}');

		expect(calls[0].init.method).toBe('PUT');
		expect(calls[0].url).toBe(`${BASE}/sync/${PACKET}`);
		expect(calls[0].headers['If-None-Match']).toBe('*');
		expect(calls[0].init.body).toBe('{"x":1}');
	});

	it('reports a taken name as a conflict', async () => {
		const { transport } = setup(() => status(412));
		await expect(transport.uploadFile('/sync', PACKET, '{}')).rejects.toMatchObject({ kind: 'conflict' });
	});

	it('treats a missing parent as a missing folder, not a conflict, and recreates it next time', async () => {
		let putStatus = 409;
		const { transport, calls } = setup((call) => (call.init.method === 'MKCOL' ? status(201) : status(putStatus)));
		await transport.ensureFolder('/sync');

		await expect(transport.uploadFile('/sync', PACKET, '{}')).rejects.toMatchObject({ kind: 'not_found' });

		putStatus = 201;
		await transport.ensureFolder('/sync');
		expect(calls.filter((call) => call.init.method === 'MKCOL')).toHaveLength(2);
	});
});

describe('WebDavTransport.listFiles', () => {
	it('reads files whatever namespace prefix the server uses, skipping folders', async () => {
		const xml = `<?xml version="1.0"?>
			<d:multistatus xmlns:d="DAV:">
				<d:response><d:href>/remote.php/dav/files/shop/sync/</d:href></d:response>
				<d:response><d:href>/remote.php/dav/files/shop/sync/${PACKET}</d:href></d:response>
				<d:response><d:href>/remote.php/dav/files/shop/sync/archive/</d:href></d:response>
			</d:multistatus>`;
		const { transport, calls } = setup(() => multistatus(xml));

		expect(await transport.listFiles('/sync')).toEqual([{ name: PACKET, size: 0, modifiedAt: '' }]);
		expect(calls[0].init.method).toBe('PROPFIND');
		expect(calls[0].url).toBe(`${BASE}/sync/`);
		expect(calls[0].headers.Depth).toBe('1');
	});

	it.each([
		['upper-case prefix', (href: string) => `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${href}</D:href></D:response></D:multistatus>`],
		['default namespace', (href: string) => `<multistatus xmlns="DAV:"><response><href>${href}</href></response></multistatus>`],
		['padded text', (href: string) => `<a:href xmlns:a="DAV:">\n  ${href}\n</a:href>`]
	])('handles %s', async (_label, render) => {
		const { transport } = setup(() => multistatus(render(`/dav/sync/${PACKET}`)));
		expect((await transport.listFiles('/sync')).map((file) => file.name)).toEqual([PACKET]);
	});

	it('handles absolute and percent-encoded hrefs, ignoring undecodable names', async () => {
		const encoded = PACKET.replace('_', '%5F');
		const xml = `<d:href>https://nas.example/dav/sync/${encoded}</d:href><d:href>/dav/sync/bad%E0%A4%A</d:href>`;
		const { transport } = setup(() => multistatus(xml));
		expect((await transport.listFiles('/sync')).map((file) => file.name)).toEqual([PACKET]);
	});

	it('is empty when the folder does not exist yet', async () => {
		const { transport } = setup(() => status(404));
		expect(await transport.listFiles('/sync')).toEqual([]);
	});

	it('does not mistake a website for an empty folder', async () => {
		const { transport } = setup(() => new Response('<html>Please log in</html>', { status: 200 }));
		await expect(transport.listFiles('/sync')).rejects.toThrow(/did not answer as a WebDAV server/);
	});
});

describe('WebDavTransport.downloadFile', () => {
	it('returns the packet text', async () => {
		const { transport, calls } = setup(() => new Response('{"ok":true}', { status: 200 }));
		expect(await transport.downloadFile('/sync', PACKET)).toBe('{"ok":true}');
		expect(calls[0].init.method).toBe('GET');
	});

	it('reports a missing packet', async () => {
		const { transport } = setup(() => status(404));
		await expect(transport.downloadFile('/sync', PACKET)).rejects.toMatchObject({ kind: 'not_found' });
	});
});

describe('WebDavTransport errors', () => {
	it.each([
		[401, 'auth'],
		[403, 'auth'],
		[418, 'unknown'],
		[500, 'server'],
		[507, 'server']
	])('maps %i to %s', async (code, kind) => {
		const { transport } = setup(() => status(code));
		await expect(transport.downloadFile('/sync', PACKET)).rejects.toMatchObject({ kind });
	});

	it('honours Retry-After', async () => {
		const { transport } = setup(() => status(429, { 'Retry-After': '30' }));
		await expect(transport.downloadFile('/sync', PACKET)).rejects.toMatchObject({ kind: 'rate_limit', options: { retryAfterMs: 30_000 } });
	});

	it('keeps server pages and credentials out of the message', async () => {
		const { transport } = setup(() => new Response('<html>huge error page</html>', { status: 500 }));
		const error = (await transport.downloadFile('/sync', PACKET).catch((caught) => caught)) as Error;
		expect(error.message).toBe('WebDAV server answered 500 to GET.');
		expect(error.message).not.toContain('secret-pass');
	});
});
