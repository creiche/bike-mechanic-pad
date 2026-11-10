// DataChannel message size limits differ between browsers, so messages travel as small binary frames. The channel is
// ordered and reliable, so a frame needs only a "more follows" flag. Bytes, not string slices: cutting a string could
// split an emoji in two.

const MORE = 0;
const LAST = 1;
const FRAME_PAYLOAD_BYTES = 16 * 1024 - 1;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const BUFFER_HIGH_BYTES = 256 * 1024;

function drained(channel: RTCDataChannel): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			channel.removeEventListener('bufferedamountlow', finish);
			channel.removeEventListener('close', finish);
			resolve();
		};
		channel.addEventListener('bufferedamountlow', finish);
		channel.addEventListener('close', finish);
	});
}

// Callers must not overlap sends on one channel, or frames of different messages would interleave.
export async function sendFramed(channel: RTCDataChannel, text: string): Promise<void> {
	channel.bufferedAmountLowThreshold = BUFFER_HIGH_BYTES / 2;
	const bytes = new TextEncoder().encode(text);

	for (let offset = 0; ; offset += FRAME_PAYLOAD_BYTES) {
		const end = Math.min(offset + FRAME_PAYLOAD_BYTES, bytes.length);
		const frame = new Uint8Array(1 + end - offset);
		frame[0] = end === bytes.length ? LAST : MORE;
		frame.set(bytes.subarray(offset, end), 1);

		if (channel.bufferedAmount > BUFFER_HIGH_BYTES) await drained(channel);
		channel.send(frame);
		if (end === bytes.length) return;
	}
}

export class FrameAssembler {
	private parts: Uint8Array[] = [];
	private total = 0;

	// Returns the finished message, or null while more frames are expected. Throws on input no honest sender produces.
	push(data: ArrayBuffer): string | null {
		const frame = new Uint8Array(data);
		if (frame.length === 0 || (frame[0] !== MORE && frame[0] !== LAST)) throw new Error('Malformed frame.');

		this.total += frame.length - 1;
		if (this.total > MAX_MESSAGE_BYTES) throw new Error('Message too large.');
		this.parts.push(frame.subarray(1));
		if (frame[0] === MORE) return null;

		const message = new Uint8Array(this.total);
		let offset = 0;
		for (const part of this.parts) {
			message.set(part, offset);
			offset += part.length;
		}
		this.parts = [];
		this.total = 0;
		return new TextDecoder('utf-8', { fatal: true }).decode(message);
	}
}
