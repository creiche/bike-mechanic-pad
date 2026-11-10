// Keeps the screen on while `set(true)`. The browser drops the lock whenever the app is hidden, so it is taken again on
// return. Also retried on a tap, because some browsers refuse a wake lock outside a user gesture.
export class ScreenWake {
	private wanted = false;
	private sentinel: WakeLockSentinel | null = null;
	private requesting = false;

	constructor() {
		for (const event of ['visibilitychange', 'pointerdown']) globalThis.document?.addEventListener(event, this.acquire);
	}

	set(wanted: boolean): void {
		if (wanted === this.wanted) return;
		this.wanted = wanted;
		if (wanted) void this.acquire();
		else void this.sentinel?.release();
	}

	private readonly acquire = async (): Promise<void> => {
		const wakeLock = globalThis.navigator?.wakeLock;
		if (!wakeLock || !this.wanted || this.sentinel || this.requesting || globalThis.document?.hidden) return;
		this.requesting = true;
		try {
			const sentinel = await wakeLock.request('screen');
			this.sentinel = sentinel;
			sentinel.addEventListener('release', () => {
				if (this.sentinel === sentinel) this.sentinel = null;
			});
			if (!this.wanted) void sentinel.release();
		} catch {
			// Refused, for example on low battery. Sync still works; the screen may just sleep.
		} finally {
			this.requesting = false;
		}
	};
}
