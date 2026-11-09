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
			? { label: 'Sign-in expired', tone: 'error' }
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
