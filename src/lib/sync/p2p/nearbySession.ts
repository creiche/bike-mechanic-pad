import { peerTrustRepository, type PeerTrustRepository, type TrustedPeer } from '../../db/repositories/sync';
import type { DeviceIdentity } from '../device';
import type { PeerTransport } from '../transport';
import { joinPairing, pairingFingerprint, startPairing, type PeerLink } from './pairing';
import type { MeshMessage, SignalMessage } from './protocol';
import { WebRtcTransport, type WebRtcTransportOptions } from './webrtcTransport';

// The steps of pairing, in the order a person sees them. `code` is what this device must show to the other one.
export type NearbyState =
	| { phase: 'idle'; message: string | null }
	| { phase: 'preparing' }
	| { phase: 'offering'; code: string } // first device: showing its code, then scanning the reply
	| { phase: 'answering'; code: string } // second device: showing its reply, waiting to be scanned
	| { phase: 'connecting' };

// A remembered device, and whether it is linked right now.
export interface NearbyPeer {
	deviceId: string;
	deviceName: string;
	linked: boolean;
}

// Test seam; defaults to real WebRTC.
export interface NearbyPairingApi {
	start: typeof startPairing;
	join: typeof joinPairing;
	connect(link: PeerLink, options: WebRtcTransportOptions): Promise<PeerTransport>;
}

export interface NearbySessionOptions {
	identity: () => DeviceIdentity;
	onChange: () => void;
	onConnected: (transport: PeerTransport) => void;
	onEnded: (deviceId: string) => void;
	pairing?: NearbyPairingApi;
	trust?: PeerTrustRepository;
}

const IDLE: NearbyState = { phase: 'idle', message: null };
// A relayed link has no person lining up a scan, so it either works quickly or not at all.
const RELAYED_CONNECT_TIMEOUT_MS = 15_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Owns every nearby link, and at most one QR pairing in progress. Each async pairing step checks `attempt` afterwards,
// so a person pressing Cancel mid-step wins.
//
// A browser cannot listen for incoming connections, so a dropped link needs someone to carry a fresh handshake. Any
// device linked to both ends can do that (see onMesh), which is why one QR pairing brings a restarted device back to all.
export class NearbySession {
	private state: NearbyState = IDLE;
	private attempt = 0;
	private link: PeerLink | null = null;
	private acceptReply: ((answer: string) => Promise<void>) | null = null;
	private readonly pairing: NearbyPairingApi;
	private readonly trust: PeerTrustRepository;

	private readonly links = new Map<string, PeerTransport>();
	private readonly trusted = new Map<string, TrustedPeer>();
	private readonly peerLists = new Map<string, string[]>(); // what each linked device says it is linked to
	private readonly dialing = new Set<string>();
	private readonly relisted = new Set<string>(); // devices named in a peer list while an attempt to reach them was running
	private readonly abandonDial = new Map<string, () => void>(); // gives up an attempt that fresh news has made pointless
	private readonly awaitingAnswer = new Map<string, (answer: string) => Promise<void>>();
	private meshEpoch = 0; // bumped by end(), so a relayed link finishing afterwards is dropped

	constructor(private readonly options: NearbySessionOptions) {
		this.pairing = options.pairing ?? { start: startPairing, join: joinPairing, connect: WebRtcTransport.connect.bind(WebRtcTransport) };
		this.trust = options.trust ?? peerTrustRepository;
	}

	getState(): NearbyState {
		return this.state;
	}

	getPeers(): NearbyPeer[] {
		return [...this.trusted.values()].map(({ deviceId, deviceName }) => {
			const link = this.links.get(deviceId);
			return { deviceId, deviceName: link?.displayName ?? deviceName, linked: link !== undefined };
		});
	}

	// Reads remembered devices. Without them everything still works, but only by QR.
	async loadTrusted(): Promise<void> {
		try {
			for (const peer of await this.trust.getTrustedPeers()) this.trusted.set(peer.deviceId, peer);
			this.options.onChange();
		} catch (error) {
			console.warn('Could not load remembered devices.', error);
		}
	}

	// First device. Rejects when no code could be made.
	async offer(): Promise<void> {
		const attempt = this.begin();
		try {
			const { payload, link, accept } = await this.pairing.start();
			if (attempt !== this.attempt) return link.pc.close();
			this.link = link;
			this.acceptReply = accept;
			this.setState({ phase: 'offering', code: payload });
		} catch (error) {
			if (attempt === this.attempt) this.setState(IDLE);
			throw error;
		}
	}

	// Second device, with the first device's code. Rejects when the code is not valid, leaving the scanner free to retry.
	async join(offer: string): Promise<void> {
		const attempt = this.begin();
		try {
			const { payload, link } = await this.pairing.join(offer);
			if (attempt !== this.attempt) return link.pc.close();
			this.link = link;
			this.setState({ phase: 'answering', code: payload });
			void this.connect(attempt, link, pairingFingerprint(offer));
		} catch (error) {
			if (attempt === this.attempt) this.setState(IDLE);
			throw error;
		}
	}

	// First device, with the reply it scanned. Rejects on an invalid code and stays on the same step.
	async acceptAnswer(answer: string): Promise<void> {
		const { state, link, acceptReply } = this;
		if (state.phase !== 'offering' || !link || !acceptReply) return;

		const attempt = this.attempt;
		this.setState({ phase: 'connecting' }); // set first, so a second scan of the same code cannot get in
		try {
			await acceptReply(answer);
		} catch (error) {
			if (attempt === this.attempt) this.setState(state);
			throw error;
		}
		if (attempt === this.attempt) void this.connect(attempt, link, pairingFingerprint(answer));
	}

	// Cancel the pairing in progress. Existing links stay up.
	cancel(): void {
		const { link } = this;
		this.clear();
		this.setState(IDLE);
		link?.pc.close();
	}

	// Cancel any pairing and drop every link. Remembered devices stay remembered.
	end(): void {
		this.cancel();
		this.meshEpoch++;
		this.peerLists.clear();
		const live = [...this.links.values()];
		this.links.clear();
		for (const transport of live) {
			this.options.onEnded(transport.peerDeviceId);
			void transport.disconnect();
		}
		this.options.onChange();
	}

	// Stops trusting a device. It takes a new QR pairing to link again.
	async forget(deviceId: string): Promise<void> {
		await this.trust.forgetPeer(deviceId);
		this.trusted.delete(deviceId);
		this.peerLists.delete(deviceId);
		const transport = this.links.get(deviceId);
		if (transport) {
			this.links.delete(deviceId);
			this.options.onEnded(deviceId);
			void transport.disconnect();
			this.announce();
		}
		this.options.onChange();
	}

	private begin(): number {
		this.cancel();
		this.setState({ phase: 'preparing' });
		return this.attempt;
	}

	private clear(): void {
		this.attempt++;
		this.link = this.acceptReply = null;
	}

	private async open(link: PeerLink, connectTimeoutMs?: number): Promise<PeerTransport> {
		let transport: PeerTransport | undefined;
		transport = await this.pairing.connect(link, {
			identity: this.options.identity(),
			connectTimeoutMs,
			onClose: () => transport && this.onLinkClosed(transport),
			onMesh: (message) => transport && this.onMesh(transport, message)
		});
		return transport;
	}

	// `fingerprint` came through the camera, so finishing this connection is what makes the device trusted.
	private async connect(attempt: number, link: PeerLink, fingerprint: string): Promise<void> {
		try {
			const transport = await this.open(link);
			if (attempt !== this.attempt) return void (await transport.disconnect());
			this.clear();
			this.state = IDLE;
			const epoch = this.meshEpoch;
			await this.remember(transport, fingerprint); // saved before "Connected" shows, so a quick reload cannot lose it
			if (epoch !== this.meshEpoch) return void (await transport.disconnect()); // cancelled while saving
			this.addLink(transport);
		} catch (error) {
			if (attempt !== this.attempt) return;
			this.clear();
			this.setState({ phase: 'idle', message: messageOf(error) });
		}
	}

	private async remember(transport: PeerTransport, fingerprint: string): Promise<void> {
		const peer = { deviceId: transport.peerDeviceId, deviceName: transport.displayName, fingerprint };
		this.trusted.set(peer.deviceId, peer);
		// The link is up either way; a failed save only means pairing by QR again after a restart.
		await this.trust.trustPeer(peer).catch((error) => console.warn('Could not remember this device.', error));
	}

	private addLink(transport: PeerTransport): void {
		const deviceId = transport.peerDeviceId;
		const stale = this.links.get(deviceId); // the other device reloaded and this end has not noticed yet
		this.links.set(deviceId, transport);
		if (stale) {
			this.options.onEnded(deviceId);
			void stale.disconnect();
		}
		this.options.onConnected(transport);
		if (this.state.phase === 'idle' && this.state.message) this.state = IDLE;
		this.announce();
		this.completeMesh(); // this device's lists may have arrived before the link was added, while it was being saved
		this.options.onChange();
	}

	private onLinkClosed(transport: PeerTransport): void {
		const deviceId = transport.peerDeviceId;
		if (this.links.get(deviceId) !== transport) return; // replaced or dropped on purpose
		this.links.delete(deviceId);
		this.peerLists.delete(deviceId);
		this.options.onEnded(deviceId);
		if (this.state.phase === 'idle') this.state = { phase: 'idle', message: `${transport.displayName} disconnected. Pair again to keep syncing.` };
		this.options.onChange();
		this.announce();
		this.completeMesh(); // a device already listed may have been skipped while this link looked alive
	}

	private announce(): void {
		const devices = [...this.links.keys()];
		for (const transport of this.links.values()) transport.sendMesh({ t: 'peers', devices });
	}

	private onMesh(via: PeerTransport, message: MeshMessage): void {
		if (message.t === 'peers') {
			this.peerLists.set(via.peerDeviceId, message.devices);
			for (const device of message.devices) {
				if (!this.dialing.has(device)) continue;
				// An attempt started while the device was down would otherwise hold up the fresh one until its timeout ends.
				this.relisted.add(device);
				this.abandonDial.get(device)?.();
			}
			this.completeMesh();
		} else if (message.to !== this.options.identity().deviceId) {
			// Only ever one hop: this reaches the addressee directly, or goes nowhere.
			this.links.get(message.to)?.sendMesh(message);
		} else if (message.kind === 'o') {
			void this.answerRelayed(via, message);
		} else {
			this.acceptRelayed(message);
		}
	}

	// Link to every remembered device that a linked device can reach. Only the lower id offers, so two devices never
	// offer to each other at once. A device that is not remembered is skipped: only a QR scan creates trust.
	private completeMesh(): void {
		const me = this.options.identity().deviceId;
		for (const [viaId, devices] of this.peerLists) {
			const via = this.links.get(viaId);
			if (!via) continue;
			for (const target of devices) {
				if (me < target && this.trusted.has(target) && !this.links.has(target) && !this.dialing.has(target)) void this.dial(via, target);
			}
		}
	}

	private async dial(via: PeerTransport, target: string): Promise<void> {
		this.dialing.add(target);
		let abandoned = false;
		let started: PeerLink | undefined;
		const superseded = new Promise<void>((resolve) =>
			this.abandonDial.set(target, () => {
				abandoned = true;
				started?.pc.close(); // also ends the wait inside connectRelayed
				resolve();
			})
		);
		const attempt = (async () => {
			const { payload, link, accept } = await this.pairing.start();
			started = link;
			if (abandoned) return void link.pc.close();
			this.awaitingAnswer.set(target, accept);
			via.sendMesh({ t: 'signal', to: target, from: this.options.identity().deviceId, kind: 'o', code: payload });
			await this.connectRelayed(link, target);
		})();
		try {
			await Promise.race([attempt, superseded]);
		} catch (error) {
			console.warn('Could not reach a remembered device.', error);
		} finally {
			attempt.catch(() => {}); // an abandoned attempt may still fail later; nobody is waiting for it
			if (!this.links.has(target)) started?.pc.close();
			this.abandonDial.delete(target);
			this.dialing.delete(target);
			this.awaitingAnswer.delete(target);
			// Fresh news arrived mid-attempt: this one may have gone to a device that has since restarted, so try again now.
			if (this.relisted.delete(target)) this.completeMesh();
		}
	}

	private isSavedFingerprint(message: SignalMessage): boolean {
		return this.trusted.get(message.from)?.fingerprint === pairingFingerprint(message.code);
	}

	// An offer means the other device sees no link, so any link this end still holds to it is stale and gets replaced.
	private async answerRelayed(via: PeerTransport, message: SignalMessage): Promise<void> {
		if (!this.isSavedFingerprint(message)) return;
		try {
			const { payload, link } = await this.pairing.join(message.code);
			via.sendMesh({ t: 'signal', to: message.from, from: this.options.identity().deviceId, kind: 'a', code: payload });
			await this.connectRelayed(link, message.from);
		} catch (error) {
			console.warn('Could not answer a remembered device.', error);
		}
	}

	private acceptRelayed(message: SignalMessage): void {
		const accept = this.awaitingAnswer.get(message.from);
		if (!accept || !this.isSavedFingerprint(message)) return;
		this.awaitingAnswer.delete(message.from);
		accept(message.code).catch((error) => console.warn('A remembered device sent an unusable reply.', error));
	}

	private async connectRelayed(link: PeerLink, target: string): Promise<void> {
		const epoch = this.meshEpoch;
		const transport = await this.open(link, RELAYED_CONNECT_TIMEOUT_MS);
		// The fingerprint proved which certificate is on the other end; the hello must then match who that certificate belongs to.
		if (epoch !== this.meshEpoch || transport.peerDeviceId !== target || !this.trusted.has(target)) return void (await transport.disconnect());
		this.addLink(transport);
	}

	private setState(state: NearbyState): void {
		this.state = state;
		this.options.onChange();
	}
}
