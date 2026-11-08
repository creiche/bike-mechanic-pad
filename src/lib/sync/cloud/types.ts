export type CloudErrorKind =
	| 'offline'
	| 'timeout'
	| 'auth'
	| 'conflict'
	| 'not_found'
	| 'rate_limit'
	| 'server'
	| 'unknown';

export class CloudError extends Error {
	constructor(
		readonly kind: CloudErrorKind,
		message: string,
		readonly options: { retryAfterMs?: number; cause?: unknown } = {}
	) {
		super(message, { cause: options.cause });
		this.name = 'CloudError';
	}
}

export interface RemoteFile {
	name: string;
	size: number;
	modifiedAt: string;
}

// Provider-neutral storage relay. Paths are folder paths such as "/sync"; file names never contain "/".
// Implementations must throw CloudError so the sync service can tell offline from auth from conflict.
export interface CloudStorageAdapter {
	readonly id: string;
	readonly displayName: string;
	isConnected(): boolean;
	disconnect(): Promise<void>;
	// No-op when the folder already exists.
	ensureFolder(folderPath: string): Promise<void>;
	// Never overwrites: throws CloudError('conflict') when the file name is taken.
	uploadFile(folderPath: string, name: string, content: string): Promise<void>;
	// Empty list when the folder does not exist yet.
	listFiles(folderPath: string): Promise<RemoteFile[]>;
	downloadFile(folderPath: string, name: string): Promise<string>;
}
