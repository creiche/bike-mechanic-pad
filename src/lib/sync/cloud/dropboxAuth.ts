import { fetchWithTimeout, type FetchLike } from './http';
import { CloudError } from './types';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';

const TOKENS_KEY = 'bmp.sync.dropbox.tokens';
const PKCE_KEY = 'bmp.sync.dropbox.pkce';
// Refresh a little early so a token never expires mid-request.
const EXPIRY_MARGIN_MS = 60_000;

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface DropboxAuthConfig {
	// Dropbox "App key"; PKCE needs no client secret, so nothing secret ships in the bundle.
	appKey: string;
	redirectUri: string;
	// Long-lived tokens. Defaults to localStorage (OPFS data is already per-origin and unencrypted).
	storage?: KeyValueStorage;
	// Short-lived PKCE verifier for the redirect round trip. Defaults to sessionStorage.
	sessionStorage?: KeyValueStorage;
	fetch?: FetchLike;
	now?: () => number;
}

interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// OAuth 2.0 authorization-code flow with PKCE, plus access-token refresh, for Dropbox.
export class DropboxAuth {
	private readonly storage: KeyValueStorage;
	private readonly session: KeyValueStorage;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private refreshing: Promise<StoredTokens> | null = null;

	constructor(private readonly config: DropboxAuthConfig) {
		if (!config.appKey) throw new Error('A Dropbox app key is required.');
		this.storage = config.storage ?? localStorage;
		this.session = config.sessionStorage ?? sessionStorage;
		this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
		this.now = config.now ?? Date.now;
	}

	get appKey(): string {
		return this.config.appKey;
	}

	isConnected(): boolean {
		return this.readTokens() !== null;
	}

	// Step 1: send the user to the returned URL to grant access to the app folder.
	async createAuthorizationUrl(): Promise<string> {
		const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
		const state = crypto.randomUUID();
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		this.session.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

		const url = new URL(AUTHORIZE_URL);
		url.search = new URLSearchParams({
			client_id: this.config.appKey,
			response_type: 'code',
			code_challenge: base64Url(new Uint8Array(digest)),
			code_challenge_method: 'S256',
			token_access_type: 'offline',
			redirect_uri: this.config.redirectUri,
			state
		}).toString();
		return url.toString();
	}

	// Step 2: call with the URL Dropbox redirected back to; exchanges the code for tokens.
	async completeAuthorization(callbackUrl: string | URL): Promise<void> {
		const params = new URL(callbackUrl).searchParams;
		const stored = this.session.getItem(PKCE_KEY);
		this.session.removeItem(PKCE_KEY);

		const denied = params.get('error');
		if (denied) throw new CloudError('auth', `Dropbox authorization failed: ${params.get('error_description') ?? denied}`);

		const code = params.get('code');
		if (!code || !stored) throw new CloudError('auth', 'No pending Dropbox authorization.');
		const { verifier, state } = JSON.parse(stored) as { verifier: string; state: string };
		if (params.get('state') !== state) throw new CloudError('auth', 'Dropbox authorization state mismatch.');

		const tokens = await this.requestTokens({
			grant_type: 'authorization_code',
			code,
			code_verifier: verifier,
			redirect_uri: this.config.redirectUri
		});
		this.writeTokens(tokens);
	}

	// Returns a valid access token, refreshing it first when it is expired or `forceRefresh` is set.
	async getAccessToken(forceRefresh = false): Promise<string> {
		const tokens = this.readTokens();
		if (!tokens) throw new CloudError('auth', 'Dropbox is not connected.');
		if (!forceRefresh && tokens.expiresAt - EXPIRY_MARGIN_MS > this.now()) return tokens.accessToken;

		// Concurrent callers share one refresh request.
		this.refreshing ??= this.refresh(tokens).finally(() => {
			this.refreshing = null;
		});
		return (await this.refreshing).accessToken;
	}

	async disconnect(): Promise<void> {
		const tokens = this.readTokens();
		this.storage.removeItem(TOKENS_KEY);
		if (!tokens) return;

		// Best effort: the local sign-out already happened, so a failed revoke is not an error.
		try {
			await fetchWithTimeout(this.fetchImpl, REVOKE_URL, {
				method: 'POST',
				headers: { Authorization: `Bearer ${tokens.accessToken}` }
			});
		} catch {
			/* offline or already revoked */
		}
	}

	private async refresh(tokens: StoredTokens): Promise<StoredTokens> {
		try {
			const refreshed = await this.requestTokens({
				grant_type: 'refresh_token',
				refresh_token: tokens.refreshToken
			});
			this.writeTokens({ ...refreshed, refreshToken: refreshed.refreshToken || tokens.refreshToken });
			return this.readTokens() as StoredTokens;
		} catch (error) {
			// A revoked or expired refresh token cannot recover; make the user sign in again.
			if (error instanceof CloudError && error.kind === 'auth') this.storage.removeItem(TOKENS_KEY);
			throw error;
		}
	}

	private async requestTokens(form: Record<string, string>): Promise<StoredTokens> {
		const response = await fetchWithTimeout(this.fetchImpl, TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ...form, client_id: this.config.appKey })
		});

		if (response.status === 400 || response.status === 401) {
			throw new CloudError('auth', 'Dropbox rejected the authorization; sign in again.');
		}
		if (!response.ok) {
			throw new CloudError(response.status >= 500 ? 'server' : 'unknown', `Dropbox token request failed (${response.status}).`);
		}

		const body = (await response.json()) as TokenResponse;
		return {
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? '',
			expiresAt: this.now() + body.expires_in * 1000
		};
	}

	private readTokens(): StoredTokens | null {
		const raw = this.storage.getItem(TOKENS_KEY);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StoredTokens;
		} catch {
			return null;
		}
	}

	private writeTokens(tokens: StoredTokens): void {
		this.storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
	}
}
