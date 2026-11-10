import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenWake } from './screenWake';

function fakeBrowser(request: () => Promise<unknown>) {
	const listeners = new Map<string, () => void>();
	const document = { hidden: false, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) };
	vi.stubGlobal('document', document);
	vi.stubGlobal('navigator', { wakeLock: { request } });
	return { document, fire: (type: string) => listeners.get(type)?.() };
}

function fakeSentinel() {
	let onRelease = () => {};
	const release = vi.fn(async () => onRelease());
	return { release, addEventListener: (_type: string, listener: () => void) => (onRelease = listener), dropped: () => onRelease() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.unstubAllGlobals());

describe('ScreenWake', () => {
	it('holds the lock only while wanted', async () => {
		const sentinel = fakeSentinel();
		const request = vi.fn(async () => sentinel);
		fakeBrowser(request);
		const wake = new ScreenWake();

		wake.set(true);
		wake.set(true);
		await flush();
		expect(request).toHaveBeenCalledTimes(1);

		wake.set(false);
		expect(sentinel.release).toHaveBeenCalledTimes(1);
	});

	it('takes the lock again when the app returns', async () => {
		const sentinel = fakeSentinel();
		const request = vi.fn(async () => sentinel);
		const { fire } = fakeBrowser(request);
		const wake = new ScreenWake();
		wake.set(true);
		await flush();

		sentinel.dropped();
		fire('visibilitychange');
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('waits while hidden, and retries on a tap after a refusal', async () => {
		const request = vi.fn(async () => fakeSentinel()).mockRejectedValueOnce(new Error('NotAllowedError'));
		const { document, fire } = fakeBrowser(request);
		const wake = new ScreenWake();

		document.hidden = true;
		wake.set(true);
		await flush();
		expect(request).not.toHaveBeenCalled();

		document.hidden = false;
		fire('visibilitychange');
		await flush();
		fire('pointerdown');
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('does nothing where the browser has no wake lock', () => {
		vi.stubGlobal('navigator', {});
		expect(() => new ScreenWake().set(true)).not.toThrow();
	});
});
