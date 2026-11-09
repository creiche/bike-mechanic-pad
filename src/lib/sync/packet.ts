import { SyncProtocolError, type OutboxEntry } from '../db/repositories/sync';
import type { DeviceIdentity } from './device';

export const SYNC_PACKET_VERSION = 1;

// One immutable batch of a device's outbox rows, stored as a single JSON file in the shared cloud folder.
// No timestamp field: the same seq range always serializes identically, so a retried upload is detectable.
export interface SyncPacket {
	version: typeof SYNC_PACKET_VERSION;
	deviceId: string;
	deviceName: string;
	startSeq: number;
	endSeq: number;
	// Number of deltas written; catches a dropped middle delta, which a seq-range check cannot (restores leave legit gaps).
	count: number;
	deltas: OutboxEntry[];
}

export interface PacketRef {
	deviceId: string;
	startSeq: number;
	endSeq: number;
}

const FILE_NAME_PATTERN = /^([A-Za-z0-9-]+)_(\d{12})_(\d{12})\.json$/;
const pad = (seq: number) => String(seq).padStart(12, '0');

export function packetFileName({ deviceId, startSeq, endSeq }: PacketRef): string {
	return `${deviceId}_${pad(startSeq)}_${pad(endSeq)}.json`;
}

// Returns null for files that are not sync packets, so stray files in the folder are ignored.
export function parsePacketFileName(name: string): PacketRef | null {
	const match = FILE_NAME_PATTERN.exec(name);
	if (!match) return null;
	return { deviceId: match[1], startSeq: Number(match[2]), endSeq: Number(match[3]) };
}

// `deltas` must be non-empty and ordered by seq, as returned by getSyncDelta().
export function buildPacket(identity: DeviceIdentity, deltas: OutboxEntry[]): SyncPacket {
	if (deltas.length === 0) throw new Error('Cannot build a sync packet without deltas.');
	return {
		version: SYNC_PACKET_VERSION,
		deviceId: identity.deviceId,
		deviceName: identity.deviceName,
		startSeq: deltas[0].seq,
		endSeq: deltas[deltas.length - 1].seq,
		count: deltas.length,
		deltas
	};
}

function isDelta(value: unknown): value is OutboxEntry {
	if (typeof value !== 'object' || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(row.seq) &&
		typeof row.id === 'string' &&
		typeof row.entity_type === 'string' &&
		typeof row.entity_id === 'string' &&
		typeof row.action === 'string' &&
		typeof row.payload === 'string' &&
		typeof row.created_at === 'string'
	);
}

// buildPacket() makes the first and last seq equal the file-name bounds, so a packet must be non-empty, strictly
// increasing (no duplicates) and touch both bounds. Not required to be gap-free: restoring a backup deletes
// superseded DELETE rows from the middle of the outbox, so legitimate packets can skip seqs.
function isOrderedWithinBounds(deltas: OutboxEntry[], { startSeq, endSeq }: PacketRef): boolean {
	return (
		deltas.length > 0 &&
		deltas[0].seq === startSeq &&
		deltas[deltas.length - 1].seq === endSeq &&
		deltas.every((delta, i) => i === 0 || delta.seq > deltas[i - 1].seq)
	);
}

// Remote files are untrusted input: check structure, and that the content matches the file name.
export function parsePacket(text: string, expected: PacketRef): SyncPacket {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new SyncProtocolError(`Packet ${packetFileName(expected)} is not valid JSON.`);
	}

	const packet = data as Partial<SyncPacket> | null;
	if (!packet || typeof packet !== 'object') {
		throw new SyncProtocolError(`Packet ${packetFileName(expected)} is not an object.`);
	}
	if (packet.version !== SYNC_PACKET_VERSION) {
		throw new SyncProtocolError(`Packet version ${String(packet.version)} is not supported; update the app.`);
	}
	if (
		packet.deviceId !== expected.deviceId ||
		packet.startSeq !== expected.startSeq ||
		packet.endSeq !== expected.endSeq ||
		typeof packet.deviceName !== 'string' ||
		!Array.isArray(packet.deltas) ||
		packet.count !== packet.deltas.length ||
		!packet.deltas.every(isDelta) ||
		!isOrderedWithinBounds(packet.deltas, expected)
	) {
		throw new SyncProtocolError(`Packet ${packetFileName(expected)} does not match its file name or is malformed.`);
	}
	return packet as SyncPacket;
}
