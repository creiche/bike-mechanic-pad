// Serverless WebRTC pairing. Each device shows a short code as a QR and scans the other's. The code carries only what
// SDP cannot be rebuilt without; the other side reconstructs a full description from it.

import { deviceCertificate } from './certificate';

type PairingKind = 'o' | 'a'; // offer or answer

export interface PeerLink {
	pc: RTCPeerConnection;
	channel: RTCDataChannel;
}

const MAGIC = 'BMP1';
const MAX_CANDIDATES = 4; // each one makes the QR denser; more than a few addresses does not help on one LAN
const GATHERING_TIMEOUT_MS = 5_000;

const ICE_CREDENTIAL = /^[A-Za-z0-9+/]{4,256}$/;
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/; // SHA-256 as unpadded base64
const CANDIDATE = /^[A-Za-z0-9.:-]{1,64}#\d{1,5}$/; // "#" because IPv6 addresses contain ":"

export function encodePairing(kind: PairingKind, sdp: string): string {
	const lines = sdp.split(/\r?\n/);
	const value = (prefix: string): string => {
		const line = lines.find((candidate) => candidate.startsWith(prefix));
		if (!line) throw new Error(`Connection details are missing ${prefix}`);
		return line.slice(prefix.length);
	};

	const fingerprintBytes = value('a=fingerprint:sha-256 ')
		.split(':')
		.map((hex) => parseInt(hex, 16));
	const candidates = lines
		.filter((line) => line.startsWith('a=candidate:'))
		.map((line) => line.split(' '))
		.filter((parts) => parts[2]?.toLowerCase() === 'udp' && parts[7] === 'host') // LAN only: no STUN, no TCP
		.map((parts) => `${parts[4]}#${parts[5]}`)
		.slice(0, MAX_CANDIDATES);
	if (candidates.length === 0) throw new Error('No network address found. Connect this device to the shop Wi-Fi.');

	const fingerprint = btoa(String.fromCharCode(...fingerprintBytes)).replace(/=+$/, '');
	return [MAGIC, kind, value('a=ice-ufrag:'), value('a=ice-pwd:'), fingerprint, candidates.join(',')].join('|');
}

// Returns a full SDP description. Scanned text is untrusted and ends up inside SDP, so every field is checked: a stray
// line break could otherwise inject SDP lines of the sender's choosing.
export function decodePairing(text: string, expected: PairingKind): string {
	const [magic, kind, ufrag, pwd, fingerprint, candidateList = ''] = text.trim().split('|');
	const candidates = candidateList.split(',').filter(Boolean);
	if (
		magic !== MAGIC ||
		kind !== expected ||
		!ICE_CREDENTIAL.test(ufrag ?? '') ||
		!ICE_CREDENTIAL.test(pwd ?? '') ||
		!FINGERPRINT.test(fingerprint ?? '') ||
		candidates.length === 0 ||
		candidates.length > MAX_CANDIDATES ||
		!candidates.every((candidate) => CANDIDATE.test(candidate))
	) {
		throw new Error('That is not a valid pairing code for this step.');
	}

	const hex = [...atob(fingerprint)].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':');
	return [
		'v=0',
		'o=- 0 0 IN IP4 127.0.0.1',
		's=-',
		't=0 0',
		'a=group:BUNDLE 0',
		'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
		'c=IN IP4 0.0.0.0',
		`a=ice-ufrag:${ufrag}`,
		`a=ice-pwd:${pwd}`,
		`a=fingerprint:sha-256 ${hex}`,
		`a=setup:${kind === 'o' ? 'actpass' : 'active'}`,
		'a=mid:0',
		'a=sctp-port:5000',
		'a=max-message-size:65536',
		...candidates.map((candidate, index) => {
			const [host, port] = candidate.split('#');
			return `a=candidate:${index + 1} 1 udp ${2122260223 - index} ${host} ${port} typ host`;
		}),
		'a=end-of-candidates',
		''
	].join('\r\n');
}

// Call only on a code that passed decodePairing. This is what a device saves to recognise the other one later.
export const pairingFingerprint = (code: string): string => code.trim().split('|')[4];

async function openLink(): Promise<PeerLink> {
	const pc = new RTCPeerConnection({ iceServers: [], certificates: [await deviceCertificate()] }); // no external calls
	const channel = pc.createDataChannel('sync', { negotiated: true, id: 0 });
	channel.binaryType = 'arraybuffer';
	return { pc, channel };
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === 'complete') return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			pc.removeEventListener('icegatheringstatechange', check);
			resolve();
		};
		const check = () => {
			if (pc.iceGatheringState === 'complete') finish();
		};
		const timer = setTimeout(finish, GATHERING_TIMEOUT_MS);
		pc.addEventListener('icegatheringstatechange', check);
	});
}

// There is no channel to send late candidates over, so the code must wait for all of them.
async function localPayload(pc: RTCPeerConnection, kind: PairingKind): Promise<string> {
	await pc.setLocalDescription();
	await iceGatheringComplete(pc);
	return encodePairing(kind, pc.localDescription!.sdp);
}

// shortcut: Chromium now and then refuses the stored certificate with "no identity available" for reasons not yet
// understood (it could not be reproduced outside the app); a second attempt with a fresh connection has cleared it.
// Replace this with the real fix once the cause is found.
async function withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!/no identity available/i.test(error instanceof Error ? error.message : '')) throw error;
		return attempt();
	}
}

// First device: show `payload`, then call `accept` with the code scanned from the second device.
export function startPairing(): Promise<{ payload: string; link: PeerLink; accept(answer: string): Promise<void> }> {
	return withOneRetry(startOnce);
}

async function startOnce(): Promise<{ payload: string; link: PeerLink; accept(answer: string): Promise<void> }> {
	const link = await openLink();
	try {
		return {
			payload: await localPayload(link.pc, 'o'),
			link,
			accept: (answer) => link.pc.setRemoteDescription({ type: 'answer', sdp: decodePairing(answer, 'a') })
		};
	} catch (error) {
		link.pc.close();
		throw error;
	}
}

// Second device: call with the first device's code, then show `payload` for it to scan.
export function joinPairing(offer: string): Promise<{ payload: string; link: PeerLink }> {
	const sdp = decodePairing(offer, 'o'); // a bad code is reported at once, never retried
	return withOneRetry(() => joinOnce(sdp));
}

async function joinOnce(sdp: string): Promise<{ payload: string; link: PeerLink }> {
	const link = await openLink();
	try {
		await link.pc.setRemoteDescription({ type: 'offer', sdp });
		return { payload: await localPayload(link.pc, 'a'), link };
	} catch (error) {
		link.pc.close();
		throw error;
	}
}
