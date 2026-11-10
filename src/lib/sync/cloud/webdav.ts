import type { RelayTransport } from '../transport';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, type FetchLike } from './http';
import { CloudError, type RemoteFile } from './types';

export interface WebDavConfig {
	// Address of the WebDAV root, as returned by normalizeWebDavUrl().
	url: string;
	username: string;
	password: string;
}

export interface WebDavTransportOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
}

const LIST_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

// shortcut: reads hrefs with a pattern, not an XML parser, because only plain-ASCII packet names matter; switch to DOMParser if a server wraps hrefs in CDATA.
const HREF = /<(?:[\w.-]+:)?href(?:\s[^>]*)?>\s*([^<]+?)\s*<\/(?:[\w.-]+:)?href>/gi;

// Accepts what people paste, and returns the address without a trailing slash. Credentials travel in every request,
// so plain http is refused except to this machine.
export function normalizeWebDavUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error('Enter the full WebDAV address, starting with https://.');
	}
	const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
		throw new Error('The WebDAV address must start with https://.');
	}
	if (url.username || url.password) throw new Error('Enter the username and password in their own fields.');
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function validateWebDavUsername(username: string): void {
	if (username.includes(':')) throw new Error('A WebDAV username cannot contain ":".');
}

// Basic auth must carry UTF-8 bytes: btoa() alone throws on a password with characters beyond Latin-1.
function basicAuthorization(username: string, password: string): string {
	validateWebDavUsername(username);
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

// The last path segment of an href, or null for a collection (trailing slash) or an undecodable name.
function fileNameFromHref(href: string): string | null {
	const lastSegment = href.split('?')[0].split('/').pop();
	if (!lastSegment) return null;
	try {
		const name = decodeURIComponent(lastSegment);
		return name.includes('/') ? null : name;
	} catch {
		return null;
	}
}

const folderSegments = (folderPath: string): string[] => folderPath.split('/').filter(Boolean);

// A self-hosted shared folder (Nextcloud, a NAS, ...) speaking RFC 4918. There is no session: every request carries the
// credentials. The browser only allows this if the server sends CORS headers for this app's origin.
export class WebDavTransport implements RelayTransport {
	readonly kind = 'relay';
	// Per account: another login on the same server sees a different folder, so upload progress must not carry over.
	readonly id: string;
	readonly displayName: string;
	private readonly baseUrl: string;
	private readonly authorization: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;
	// Skips a MKCOL per level on every poll. Cleared when the server says the folder has gone.
	private readonly ensuredFolders = new Set<string>();

	constructor(config: WebDavConfig, options: WebDavTransportOptions = {}) {
		this.baseUrl = normalizeWebDavUrl(config.url);
		this.authorization = basicAuthorization(config.username, config.password);
		this.id = `webdav:${config.username}@${this.baseUrl}`;
		this.displayName = new URL(this.baseUrl).host;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	isConnected(): boolean {
		return true;
	}

	async disconnect(): Promise<void> {
		// No session to end; forgetting the saved credentials is the controller's job.
	}

	async ensureFolder(folderPath: string): Promise<void> {
		if (this.ensuredFolders.has(folderPath)) return;

		// MKCOL cannot create parents, so go from the top down.
		const segments = folderSegments(folderPath);
		for (let depth = 1; depth <= segments.length; depth++) {
			const response = await this.request('MKCOL', this.folderUrl(segments.slice(0, depth)));
			const created = response.status === 201;
			const alreadyExists = response.status === 405;
			if (!created && !alreadyExists) throw this.toCloudError('MKCOL', response);
		}
		this.ensuredFolders.add(folderPath);
	}

	async uploadFile(folderPath: string, name: string, content: string): Promise<void> {
		const response = await this.request('PUT', this.fileUrl(folderPath, name), {
			headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
			body: content
		});
		if (response.ok) return;
		if (response.status === 404 || response.status === 409) this.ensuredFolders.delete(folderPath);
		throw this.toCloudError('PUT', response);
	}

	async listFiles(folderPath: string): Promise<RemoteFile[]> {
		const response = await this.request('PROPFIND', this.folderUrl(folderSegments(folderPath)), {
			headers: { Depth: '1', 'Content-Type': 'application/xml' },
			body: LIST_BODY
		});
		if (response.status === 404) {
			this.ensuredFolders.delete(folderPath);
			return [];
		}
		if (!response.ok) throw this.toCloudError('PROPFIND', response);
		// A login page or ordinary website can answer 200. Reading that as "no files" would hide a wrong address.
		if (response.status !== 207) throw new CloudError('unknown', 'That address did not answer as a WebDAV server.');

		const xml = await response.text();
		const names = [...xml.matchAll(HREF)].map((match) => fileNameFromHref(match[1])).filter((name) => name !== null);
		return names.map((name) => ({ name, size: 0, modifiedAt: '' }));
	}

	async downloadFile(folderPath: string, name: string): Promise<string> {
		const response = await this.request('GET', this.fileUrl(folderPath, name));
		if (!response.ok) throw this.toCloudError('GET', response);
		return response.text();
	}

	// Always ends in "/": some servers redirect otherwise, and a CORS preflight cannot follow a redirect.
	private folderUrl(segments: string[]): string {
		return `${this.baseUrl}/${segments.map((segment) => `${encodeURIComponent(segment)}/`).join('')}`;
	}

	private fileUrl(folderPath: string, name: string): string {
		return `${this.folderUrl(folderSegments(folderPath))}${encodeURIComponent(name)}`;
	}

	private request(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
		return fetchWithTimeout(
			this.fetchImpl,
			url,
			{
				method,
				headers: { ...init.headers, Authorization: this.authorization },
				body: init.body,
				// Without this a logged-in Nextcloud browser session sends cookies and the request fails its CSRF check.
				credentials: 'omit',
				cache: 'no-store'
			},
			this.timeoutMs
		);
	}

	// Status only: error bodies are often whole HTML pages, and this text is shown in Settings.
	private toCloudError(method: string, response: Response): CloudError {
		const { status } = response;
		const message = `WebDAV server answered ${status} to ${method}.`;

		if (status === 401 || status === 403) return new CloudError('auth', message);
		if (status === 412) return new CloudError('conflict', message);
		// A 409 here means a missing parent folder, not a taken name; 'conflict' would send the sync service comparing files.
		if (status === 404 || status === 409) return new CloudError('not_found', message);
		if (status === 429) {
			const seconds = Number(response.headers.get('Retry-After'));
			return new CloudError('rate_limit', message, { retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : undefined });
		}
		return new CloudError(status >= 500 ? 'server' : 'unknown', message);
	}
}
