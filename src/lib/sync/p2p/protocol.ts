import { packetFileName } from '../packet';

export const PEER_PROTOCOL_VERSION = 1;
export const PEER_PACKET_ROWS = 500;

// Sent by both sides as soon as the channel opens.
export interface HelloMessage {
	t: 'hello';
	protocol: number;
	deviceId: string;
	deviceName: string;
}

// "Send me what you have after afterSeq." The sender saved that cursor in the same transaction as the rows, so this
// doubles as a durable ACK of everything before it.
export interface ListRequest {
	t: 'list';
	rid: number;
	afterSeq: number;
}

export interface GetRequest {
	t: 'get';
	rid: number;
	startSeq: number;
	endSeq: number;
}

export interface ListBody {
	files: string[];
	knownDevices: string[];
}

export type PeerResponse = { t: 'ok'; rid: number; body: ListBody | string } | { t: 'err'; rid: number; message: string };

// "These are the devices I am linked to." Sent whenever that changes, so devices can link to each other's links.
export interface PeersMessage {
	t: 'peers';
	devices: string[];
}

// A pairing code passed along by a device linked to both ends, standing in for the QR scan. The device in the middle
// is not trusted with the outcome: each end checks the code's fingerprint against the one it saved when it paired.
export interface SignalMessage {
	t: 'signal';
	to: string;
	from: string;
	kind: 'o' | 'a';
	code: string;
}

export type MeshMessage = PeersMessage | SignalMessage;
export type PeerMessage = HelloMessage | ListRequest | GetRequest | PeerResponse | MeshMessage;

const MAX_MESH_DEVICES = 32;
const MAX_PAIRING_CODE_LENGTH = 2_000; // comfortably above the largest code decodePairing accepts

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

// Must fit the packet file name format, because the peer's id ends up in one.
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);

export function isListBody(body: unknown): body is ListBody {
	const candidate = body as Partial<ListBody> | null;
	return typeof candidate === 'object' && candidate !== null && isStringArray(candidate.files) && isStringArray(candidate.knownDevices);
}

// Whatever arrives over the channel is untrusted. Returns null when it is not a well-formed message.
export function parsePeerMessage(text: string): PeerMessage | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;

	switch (value.t) {
		case 'hello':
			return typeof value.protocol === 'number' && isDeviceId(value.deviceId) && typeof value.deviceName === 'string'
				? (value as unknown as HelloMessage)
				: null;
		case 'list':
			return isSeq(value.rid) && isSeq(value.afterSeq) ? (value as unknown as ListRequest) : null;
		case 'get':
			return isSeq(value.rid) && isSeq(value.startSeq) && isSeq(value.endSeq) && value.startSeq <= value.endSeq
				? (value as unknown as GetRequest)
				: null;
		case 'ok':
			return isSeq(value.rid) && (typeof value.body === 'string' || isListBody(value.body)) ? (value as unknown as PeerResponse) : null;
		case 'err':
			return isSeq(value.rid) && typeof value.message === 'string' ? (value as unknown as PeerResponse) : null;
		case 'peers':
			return Array.isArray(value.devices) && value.devices.length <= MAX_MESH_DEVICES && value.devices.every(isDeviceId)
				? (value as unknown as PeersMessage)
				: null;
		case 'signal':
			return isDeviceId(value.to) &&
				isDeviceId(value.from) &&
				(value.kind === 'o' || value.kind === 'a') &&
				typeof value.code === 'string' &&
				value.code.length <= MAX_PAIRING_CODE_LENGTH
				? (value as unknown as SignalMessage)
				: null;
		default:
			return null;
	}
}

// Cuts a device's outbox seqs into packet file names, the same shape a relay folder would hold.
export function virtualPacketNames(deviceId: string, seqs: number[], rowsPerPacket: number = PEER_PACKET_ROWS): string[] {
	const names: string[] = [];
	for (let i = 0; i < seqs.length; i += rowsPerPacket) {
		const chunk = seqs.slice(i, i + rowsPerPacket);
		names.push(packetFileName({ deviceId, startSeq: chunk[0], endSeq: chunk[chunk.length - 1] }));
	}
	return names;
}
