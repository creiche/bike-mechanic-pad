import { describe, expect, it, vi } from 'vitest';
import { notifyLocalWrite, onLocalWrite } from './localWrites';

describe('local write notifications', () => {
	it('calls every listener until it unsubscribes', () => {
		const listener = vi.fn();
		const off = onLocalWrite(listener);

		notifyLocalWrite();
		off();
		notifyLocalWrite();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('survives a throwing listener and still runs the others', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const after = vi.fn();
		const offs = [
			onLocalWrite(() => {
				throw new Error('boom');
			}),
			onLocalWrite(after)
		];

		expect(() => notifyLocalWrite()).not.toThrow();
		expect(after).toHaveBeenCalledOnce();

		offs.forEach((off) => off());
		warn.mockRestore();
	});
});
