import { describe, expect, it } from 'vitest';
import { FrameAssembler, sendFramed } from './framing';

function capturingChannel(bufferedAmount = 0) {
	const frames: Uint8Array[] = [];
	const listeners = new Set<() => void>();
	const channel = {
		bufferedAmount,
		bufferedAmountLowThreshold: 0,
		send: (frame: Uint8Array) => void frames.push(frame),
		addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener)
	};
	const fire = () => [...listeners].forEach((listener) => listener());
	return { channel: channel as unknown as RTCDataChannel, frames, fire, raw: channel };
}

async function roundTrip(text: string): Promise<{ result: string | null; frameCount: number }> {
	const { channel, frames } = capturingChannel();
	await sendFramed(channel, text);
	const assembler = new FrameAssembler();
	let result: string | null = null;
	for (const frame of frames) result = assembler.push(frame.slice().buffer);
	return { result, frameCount: frames.length };
}

describe('framing', () => {
	it('carries a short message in one frame', async () => {
		expect(await roundTrip('hello')).toEqual({ result: 'hello', frameCount: 1 });
	});

	it('carries an empty message', async () => {
		expect((await roundTrip('')).result).toBe('');
	});

	it('reassembles a large message without damaging characters that straddle frames', async () => {
		const text = '🚲é'.repeat(30_000);
		const { result, frameCount } = await roundTrip(text);
		expect(result).toBe(text);
		expect(frameCount).toBeGreaterThan(1);
	});

	it('handles a message that exactly fills its frames', async () => {
		const text = 'x'.repeat((16 * 1024 - 1) * 2);
		expect(await roundTrip(text)).toEqual({ result: text, frameCount: 2 });
	});

	it('waits while the channel buffer is full', async () => {
		const { channel, frames, fire, raw } = capturingChannel(1024 * 1024);
		const sending = sendFramed(channel, 'hello');
		await Promise.resolve();
		expect(frames).toHaveLength(0);

		raw.bufferedAmount = 0;
		fire();
		await sending;
		expect(frames).toHaveLength(1);
	});

	it('resets between messages', () => {
		const assembler = new FrameAssembler();
		const frame = (flag: number, text: string) => Uint8Array.from([flag, ...new TextEncoder().encode(text)]).buffer;
		expect(assembler.push(frame(0, 'ab'))).toBeNull();
		expect(assembler.push(frame(1, 'c'))).toBe('abc');
		expect(assembler.push(frame(1, 'd'))).toBe('d');
	});

	it('rejects malformed, oversized and invalid-text input', () => {
		expect(() => new FrameAssembler().push(new ArrayBuffer(0))).toThrow('Malformed');
		expect(() => new FrameAssembler().push(Uint8Array.from([7, 65]).buffer)).toThrow('Malformed');
		expect(() => new FrameAssembler().push(Uint8Array.from([1, 0xff]).buffer)).toThrow();

		const assembler = new FrameAssembler();
		const big = new Uint8Array(17 * 1024 * 1024);
		assembler.push(big.buffer);
		expect(() => assembler.push(big.slice().buffer)).toThrow('too large');
	});
});
