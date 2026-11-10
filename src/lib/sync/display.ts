import { CloudError } from './cloud/types';
import type { SyncControllerState } from './syncController';

export type SyncTone = 'neutral' | 'ok' | 'busy' | 'warn' | 'error';

export interface SyncDisplay {
	label: string;
	tone: SyncTone;
}

// One place that turns sync state into operator-facing wording (see ARCHITECTURE.md 2.5 "User feedback").
export function describeSync(state: SyncControllerState): SyncDisplay {
	if (state.connection === 'unconfigured') return { label: 'Sync off', tone: 'neutral' };
	if (state.connection === 'disconnected') {
		return state.error?.kind === 'auth'
			? { label: 'Sign-in rejected', tone: 'error' }
			: { label: 'Not connected', tone: 'neutral' };
	}

	switch (state.status) {
		case 'syncing':
			return { label: 'Syncing', tone: 'busy' };
		case 'offline':
			return { label: 'Offline', tone: 'warn' };
		case 'error':
			return { label: 'Sync error', tone: 'error' };
		case 'idle':
			return { label: 'Up to date', tone: 'ok' };
	}
}

// What a failed connection test means in practice. The browser reports a CORS refusal exactly like a dead network, so
// the "offline" wording has to cover both.
export function explainWebDavFailure(error: unknown, appOrigin: string): string {
	if (!(error instanceof CloudError)) return error instanceof Error ? error.message : String(error);
	switch (error.kind) {
		case 'auth':
			return 'The server rejected that username or password. Nextcloud accounts need an app password from Security settings.';
		case 'offline':
		case 'timeout':
			return `Could not reach the server. Check the address and your connection. If those are right, the server is blocking this app: it must allow ${appOrigin} (see Server setup below). For a server on your local network, also allow this site to use local devices if the browser asks.`;
		case 'not_found':
			return 'The server has no WebDAV folder at that address. Check the address.';
		default:
			return error.message;
	}
}

export const toneClasses: Record<SyncTone, { dot: string; text: string }> = {
	neutral: { dot: 'bg-neutral-500', text: 'text-neutral-300' },
	ok: { dot: 'bg-emerald-500', text: 'text-emerald-300' },
	busy: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-300' },
	warn: { dot: 'bg-amber-500', text: 'text-amber-300' },
	error: { dot: 'bg-rose-500', text: 'text-rose-300' }
};

export function formatLastSynced(iso: string | null): string {
	if (!iso) return 'Never synced';
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? 'Never synced' : `Last synced ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
