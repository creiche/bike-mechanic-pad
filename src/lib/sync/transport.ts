import type { RemoteFile } from './cloud/types';
import type { MeshMessage } from './p2p/protocol';

// What every sync transport offers the pull phase: a folder-like view of packet files. Paths are folder paths such as
// "/sync"; file names never contain "/". Implementations must throw CloudError so the sync service can tell offline
// from auth from conflict.
interface TransportBase {
	readonly id: string;
	readonly displayName: string;
	isConnected(): boolean;
	disconnect(): Promise<void>;
	// Empty list when the folder does not exist yet.
	listFiles(folderPath: string): Promise<RemoteFile[]>;
	downloadFile(folderPath: string, name: string): Promise<string>;
}

// A shared folder every device writes to, so it holds the history of all of them (WebDAV).
export interface RelayTransport extends TransportBase {
	readonly kind: 'relay';
	// No-op when the folder already exists.
	ensureFolder(folderPath: string): Promise<void>;
	// Never overwrites: throws CloudError('conflict') when the file name is taken.
	uploadFile(folderPath: string, name: string, content: string): Promise<void>;
}

// One live device serving its own outbox as a virtual folder. Nothing is pushed: each side pulls from the other.
export interface PeerTransport extends TransportBase {
	readonly kind: 'peer';
	// Identifies this link among several. Only available once the link is up.
	readonly peerDeviceId: string;
	// True when no third device exists, so a parent record missing here cannot still be on its way. Read after listFiles.
	isOnlyPeer(): boolean;
	// Sends a message that lets linked devices find each other. Dropped if the link has gone.
	sendMesh(message: MeshMessage): void;
}

export type SyncTransport = RelayTransport | PeerTransport;
