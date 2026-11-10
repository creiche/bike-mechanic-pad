import { peerSyncRepository, pullPeerId, pushPeerId, SyncProtocolError, type PeerSyncRepository } from '../../db/repositories/sync';
import { DEFAULT_TIMEOUT_MS } from '../cloud/http';
import { CloudError, type RemoteFile } from '../cloud/types';
import type { DeviceIdentity } from '../device';
import { buildPacket, parsePacketFileName } from '../packet';
import type { PeerTransport } from '../transport';
import { FrameAssembler, sendFramed } from './framing';
import type { PeerLink } from './pairing';
import {
	isListBody,
	parsePeerMessage,
	PEER_PACKET_ROWS,
	PEER_PROTOCOL_VERSION,
	virtualPacketNames,
	type GetRequest,
	type HelloMessage,
	type ListBody,
	type ListRequest,
	type MeshMessage,
	type PeerMessage
} from './protocol';

export interface WebRtcTransportOptions {
	identity: DeviceIdentity;
	repository?: PeerSyncRepository;
	connectTimeoutMs?: number;
	requestTimeoutMs?: number;
	// Called once when the link ends, for whatever reason.
	onClose?: () => void;
	onMesh?: (message: MeshMessage) => void;
}

interface PendingRequest {
	resolve(body: ListBody | string): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

// Long because the joining device connects while a person lines up the second scan. A network that cannot connect
// fails sooner, through ICE.
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;

const linkLost = () => new CloudError('offline', 'The nearby device disconnected.');

// Presents a paired device's outbox as a read-only folder, and serves this device's outbox to it in return.
// Both sides only read from each other and apply inside their own sync cycle, so neither ever waits on the other's lock.
export class WebRtcTransport implements PeerTransport {
	readonly kind = 'peer';
	private readonly repository: PeerSyncRepository;
	private readonly requestTimeoutMs: number;
	private readonly assembler = new FrameAssembler();
	private readonly pending = new Map<number, PendingRequest>();
	private sendQueue: Promise<void> = Promise.resolve();
	private peer: { deviceId: string; deviceName: string } | null = null;
	private handshake: { resolve(): void; reject(error: Error): void } | null = null;
	private nextRequestId = 1;
	private closed = false;
	private onlyPeer = false;

	// Resolves once both devices have introduced themselves over the encrypted channel. Closes the link on failure.
	static async connect(link: PeerLink, options: WebRtcTransportOptions): Promise<WebRtcTransport> {
		const transport = new WebRtcTransport(link, options);
		await transport.waitForHello(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		return transport;
	}

	private constructor(
		private readonly link: PeerLink,
		private readonly options: WebRtcTransportOptions
	) {
		this.repository = options.repository ?? peerSyncRepository;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		link.channel.addEventListener('open', this.sayHello);
		link.channel.addEventListener('message', this.onFrame);
		link.channel.addEventListener('close', () => this.close(linkLost()));
		// A vanished device (walked off the Wi-Fi) may never close the channel; ICE reports it instead.
		link.pc.addEventListener('connectionstatechange', () => {
			if (link.pc.connectionState === 'failed') this.close(linkLost());
		});
	}

	get id(): string {
		return `webrtc:${this.peer?.deviceId ?? ''}`;
	}

	get displayName(): string {
		return this.peer?.deviceName ?? 'Nearby device';
	}

	isConnected(): boolean {
		return !this.closed && this.link.channel.readyState === 'open';
	}

	async disconnect(): Promise<void> {
		this.close(linkLost());
	}

	get peerDeviceId(): string {
		return this.remoteDeviceId();
	}

	isOnlyPeer(): boolean {
		return this.onlyPeer;
	}

	sendMesh(message: MeshMessage): void {
		if (this.isConnected()) this.send(message);
	}

	async listFiles(): Promise<RemoteFile[]> {
		const peerId = this.remoteDeviceId();
		const cursor = (await this.repository.getPeerState(pullPeerId(peerId)))?.last_synced_seq ?? 0;
		const [body, localDevices] = await Promise.all([this.request({ t: 'list', afterSeq: cursor }), this.repository.getKnownDeviceIds()]);
		if (!isListBody(body)) throw new SyncProtocolError('The nearby device sent a malformed file list.');

		const others = new Set([...localDevices, ...body.knownDevices]);
		others.delete(this.options.identity.deviceId);
		others.delete(peerId);
		this.onlyPeer = others.size === 0;

		// A device may only speak for itself: anything else would move another device's cursor.
		return body.files.filter((name) => parsePacketFileName(name)?.deviceId === peerId).map((name) => ({ name, size: 0, modifiedAt: '' }));
	}

	async downloadFile(_folderPath: string, name: string): Promise<string> {
		const ref = parsePacketFileName(name);
		if (ref?.deviceId !== this.remoteDeviceId()) throw new SyncProtocolError(`${name} is not a packet from the nearby device.`);
		const body = await this.request({ t: 'get', startSeq: ref.startSeq, endSeq: ref.endSeq });
		if (typeof body !== 'string') throw new SyncProtocolError('The nearby device sent a malformed packet.');
		return body;
	}

	private remoteDeviceId(): string {
		if (!this.peer) throw linkLost();
		return this.peer.deviceId;
	}

	private waitForHello(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.close(new CloudError('timeout', 'Could not reach the other device. Check both are on the same Wi-Fi.')), timeoutMs);
			this.handshake = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			};
			if (this.link.channel.readyState === 'open') this.sayHello();
		});
	}

	private readonly sayHello = (): void => {
		const { deviceId, deviceName } = this.options.identity;
		this.send({ t: 'hello', protocol: PEER_PROTOCOL_VERSION, deviceId, deviceName });
	};

	// Never rejects: a failed send means the link is gone, which close() reports to everyone waiting.
	private send(message: PeerMessage): void {
		this.sendQueue = this.sendQueue.then(() => sendFramed(this.link.channel, JSON.stringify(message))).catch(() => this.close(linkLost()));
	}

	private request(message: Omit<ListRequest, 'rid'> | Omit<GetRequest, 'rid'>): Promise<ListBody | string> {
		if (!this.isConnected()) return Promise.reject(linkLost());
		const rid = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(rid);
				reject(new CloudError('timeout', 'The nearby device did not respond.'));
			}, this.requestTimeoutMs);
			this.pending.set(rid, { resolve, reject, timer });
			this.send({ ...message, rid });
		});
	}

	private readonly onFrame = (event: MessageEvent<ArrayBuffer>): void => {
		let text: string | null;
		try {
			text = this.assembler.push(event.data);
		} catch {
			this.close(new SyncProtocolError('The nearby device sent unreadable data.'));
			return;
		}
		if (text === null) return;

		const message = parsePeerMessage(text);
		if (!message) {
			this.close(new SyncProtocolError('The nearby device sent an unknown message; update the app on both devices.'));
			return;
		}

		switch (message.t) {
			case 'hello':
				this.onHello(message);
				break;
			case 'list':
			case 'get':
				void this.respond(message);
				break;
			case 'peers':
			case 'signal':
				if (this.peer) this.options.onMesh?.(message);
				break;
			default:
				this.onResponse(message);
		}
	};

	private onHello(hello: HelloMessage): void {
		if (hello.protocol !== PEER_PROTOCOL_VERSION) {
			this.close(new SyncProtocolError('The devices run different app versions; update both.'));
		} else if (hello.deviceId === this.options.identity.deviceId) {
			this.close(new SyncProtocolError('Both devices share one device id, so they cannot sync with each other.'));
		} else {
			this.peer = { deviceId: hello.deviceId, deviceName: hello.deviceName };
			this.handshake?.resolve();
			this.handshake = null;
		}
	}

	private onResponse(response: Extract<PeerMessage, { t: 'ok' | 'err' }>): void {
		const request = this.pending.get(response.rid);
		if (!request) return; // already timed out
		this.pending.delete(response.rid);
		clearTimeout(request.timer);
		if (response.t === 'ok') request.resolve(response.body);
		else request.reject(new CloudError('server', response.message));
	}

	private async respond(request: ListRequest | GetRequest): Promise<void> {
		try {
			this.send({ t: 'ok', rid: request.rid, body: await this.serve(request) });
		} catch (error) {
			console.warn('Could not serve a nearby device.', error);
			this.send({ t: 'err', rid: request.rid, message: 'The nearby device could not read its changes.' });
		}
	}

	private async serve(request: ListRequest | GetRequest): Promise<ListBody | string> {
		if (!this.peer) throw new SyncProtocolError('Request received before hello.');
		const { identity } = this.options;

		if (request.t === 'list') {
			await this.repository.acknowledgeSync(pushPeerId(`webrtc:${this.peer.deviceId}`), this.peer.deviceName, request.afterSeq);
			const [seqs, knownDevices] = await Promise.all([this.repository.getOutboxSeqs(request.afterSeq), this.repository.getKnownDeviceIds()]);
			return { files: virtualPacketNames(identity.deviceId, seqs), knownDevices };
		}
		const deltas = await this.repository.getOutboxRange(request.startSeq, request.endSeq, PEER_PACKET_ROWS);
		return JSON.stringify(buildPacket(identity, deltas));
	}

	private close(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.handshake?.reject(reason);
		this.handshake = null;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(reason);
		}
		this.pending.clear();
		this.link.channel.close();
		this.link.pc.close();
		this.options.onClose?.();
	}
}
