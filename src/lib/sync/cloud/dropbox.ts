import type { DropboxAuth } from './dropboxAuth';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, type FetchLike } from './http';
import { CloudError, type CloudStorageAdapter, type RemoteFile } from './types';

const API_URL = 'https://api.dropboxapi.com/2';
const CONTENT_URL = 'https://content.dropboxapi.com/2';

export interface DropboxAdapterOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
}

interface ListFolderResponse {
	entries: Array<{ '.tag': string; name: string; size?: number; server_modified?: string }>;
	cursor: string;
	has_more: boolean;
}

// Dropbox requires non-ASCII characters in the Dropbox-API-Arg header to be \u-escaped.
function apiArg(value: unknown): string {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function joinPath(folderPath: string, name?: string): string {
	const folder = `/${folderPath.replace(/^\/+|\/+$/g, '')}`;
	if (name === undefined) return folder === '/' ? '' : folder; // Dropbox spells the root as ""
	if (name.includes('/')) throw new Error(`Invalid file name: ${name}`);
	return `${folder === '/' ? '' : folder}/${name}`;
}

export class DropboxAdapter implements CloudStorageAdapter {
	// Each app key has its own empty app folder, so upload progress must not carry over between keys.
	readonly id: string;
	readonly displayName = 'Dropbox';
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;

	constructor(
		private readonly auth: DropboxAuth,
		options: DropboxAdapterOptions = {}
	) {
		this.id = `dropbox:${auth.appKey}`;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	isConnected(): boolean {
		return this.auth.isConnected();
	}

	disconnect(): Promise<void> {
		return this.auth.disconnect();
	}

	async ensureFolder(folderPath: string): Promise<void> {
		const path = joinPath(folderPath);
		if (path === '') return;

		try {
			await this.call(`${API_URL}/files/create_folder_v2`, {
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, autorename: false })
			});
		} catch (error) {
			if (!(error instanceof CloudError && error.kind === 'conflict')) throw error; // already exists
		}
	}

	async uploadFile(folderPath: string, name: string, content: string): Promise<void> {
		await this.call(`${CONTENT_URL}/files/upload`, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Dropbox-API-Arg': apiArg({ path: joinPath(folderPath, name), mode: 'add', autorename: false, mute: true })
			},
			body: content
		});
	}

	async listFiles(folderPath: string): Promise<RemoteFile[]> {
		const files: RemoteFile[] = [];
		let page: ListFolderResponse;

		try {
			page = await this.listPage(`${API_URL}/files/list_folder`, { path: joinPath(folderPath), limit: 2000 });
		} catch (error) {
			if (error instanceof CloudError && error.kind === 'not_found') return [];
			throw error;
		}

		for (;;) {
			for (const entry of page.entries) {
				if (entry['.tag'] === 'file') {
					files.push({ name: entry.name, size: entry.size ?? 0, modifiedAt: entry.server_modified ?? '' });
				}
			}
			if (!page.has_more) return files;
			page = await this.listPage(`${API_URL}/files/list_folder/continue`, { cursor: page.cursor });
		}
	}

	async downloadFile(folderPath: string, name: string): Promise<string> {
		const response = await this.call(`${CONTENT_URL}/files/download`, {
			headers: { 'Dropbox-API-Arg': apiArg({ path: joinPath(folderPath, name) }) }
		});
		return response.text();
	}

	private async listPage(url: string, body: unknown): Promise<ListFolderResponse> {
		const response = await this.call(url, {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		return (await response.json()) as ListFolderResponse;
	}

	// Every Dropbox endpoint here is a POST. A 401 triggers one forced token refresh and a retry.
	private async call(url: string, init: { headers: Record<string, string>; body?: string }): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.auth.getAccessToken(attempt > 0);
			const response = await fetchWithTimeout(
				this.fetchImpl,
				url,
				{ method: 'POST', headers: { ...init.headers, Authorization: `Bearer ${token}` }, body: init.body },
				this.timeoutMs
			);

			if (response.status === 401 && attempt === 0) continue;
			if (!response.ok) throw await this.toCloudError(response);
			return response;
		}
	}

	private async toCloudError(response: Response): Promise<CloudError> {
		const detail = await response.text().catch(() => '');
		const message = `Dropbox request failed (${response.status}): ${detail.slice(0, 200)}`;

		if (response.status === 401) return new CloudError('auth', message);
		if (response.status === 429) {
			const seconds = Number(response.headers.get('Retry-After'));
			return new CloudError('rate_limit', message, { retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : undefined });
		}
		if (response.status === 409) {
			if (detail.includes('conflict')) return new CloudError('conflict', message);
			if (detail.includes('not_found')) return new CloudError('not_found', message);
			return new CloudError('unknown', message);
		}
		return new CloudError(response.status >= 500 ? 'server' : 'unknown', message);
	}
}
