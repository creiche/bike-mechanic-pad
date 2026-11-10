import { describe, expect, it } from 'vitest';
import { decodePairing, encodePairing } from './pairing';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

const sdp = (candidates: string[]) =>
	[
		'v=0',
		'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
		'a=ice-ufrag:POTF',
		'a=ice-pwd:laBwrDG572j4Pb92q80v77Ba',
		`a=fingerprint:sha-256 ${FINGERPRINT}`,
		'a=setup:actpass',
		...candidates,
		''
	].join('\r\n');

const HOST = 'a=candidate:1 1 udp 2122260223 192.168.1.20 64460 typ host generation 0';
const MDNS = 'a=candidate:2 1 UDP 2122194687 0f3c1b7e-9d3a-4a53-8e2e-3b1d6f2a7c11.local 50000 typ host';
const IPV6 = 'a=candidate:3 1 udp 2122129151 fd00::1 50001 typ host';
const TCP = 'a=candidate:4 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active';
const SRFLX = 'a=candidate:5 1 udp 1686052607 203.0.113.9 50002 typ srflx raddr 0.0.0.0 rport 0';

describe('pairing codes', () => {
	it('round-trips everything the other side needs', () => {
		const code = encodePairing('o', sdp([HOST, MDNS, IPV6]));
		const rebuilt = decodePairing(code, 'o');

		expect(rebuilt).toContain('a=ice-ufrag:POTF\r\n');
		expect(rebuilt).toContain('a=ice-pwd:laBwrDG572j4Pb92q80v77Ba\r\n');
		expect(rebuilt).toContain(`a=fingerprint:sha-256 ${FINGERPRINT}\r\n`);
		expect(rebuilt).toContain('a=setup:actpass\r\n');
		expect(rebuilt).toContain('192.168.1.20 64460 typ host');
		expect(rebuilt).toContain('0f3c1b7e-9d3a-4a53-8e2e-3b1d6f2a7c11.local 50000 typ host');
		expect(rebuilt).toContain('fd00::1 50001 typ host');
	});

	it('answers take the active DTLS role', () => {
		expect(decodePairing(encodePairing('a', sdp([HOST])), 'a')).toContain('a=setup:active\r\n');
	});

	it('keeps only local UDP candidates and stays short', () => {
		const code = encodePairing('o', sdp([HOST, TCP, SRFLX]));
		expect(code).not.toContain('203.0.113.9');
		expect(code.split('|')[5]).toBe('192.168.1.20#64460');
		expect(code.length).toBeLessThan(120);
	});

	it('caps candidates so the QR stays scannable', () => {
		const many = Array.from({ length: 8 }, (_, i) => `a=candidate:${i} 1 udp 1 192.168.1.${i} 5000 typ host`);
		expect(encodePairing('o', sdp(many)).split('|')[5].split(',')).toHaveLength(4);
	});

	it('explains when there is no address to share', () => {
		expect(() => encodePairing('o', sdp([TCP]))).toThrow(/Wi-Fi/);
	});

	it('rejects the code from the wrong step', () => {
		expect(() => decodePairing(encodePairing('o', sdp([HOST])), 'a')).toThrow(/not a valid pairing code/);
	});

	it.each([
		['unrelated QR text', 'https://example.com/'],
		['too few fields', 'BMP1|o|POTF'],
		['no candidates', 'BMP1|o|POTF|laBwrDG572j4Pb92q80v77Ba|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8|'],
		['SDP injection in a credential', 'BMP1|o|POTF\r\na=evil:1|laBwrDG572j4Pb92q80v77Ba|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8|10.0.0.1#5000'],
		['SDP injection in a candidate', 'BMP1|o|POTF|laBwrDG572j4Pb92q80v77Ba|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8|10.0.0.1#5000\r\na=evil:1'],
		['short fingerprint', 'BMP1|o|POTF|laBwrDG572j4Pb92q80v77Ba|AAEC|10.0.0.1#5000']
	])('rejects %s', (_label, text) => {
		expect(() => decodePairing(text, 'o')).toThrow(/not a valid pairing code/);
	});
});
