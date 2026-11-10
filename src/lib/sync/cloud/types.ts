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
