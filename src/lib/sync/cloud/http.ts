import { CloudError } from './types';

export type FetchLike = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 30_000;

// fetch() that reports every transport failure as a CloudError ('offline' or 'timeout').
export async function fetchWithTimeout(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		throw new CloudError('offline', 'The device is offline.');
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { ...init, signal: controller.signal });
		// Read the body while the timer runs, so a download that stalls after the headers also times out.
		await response.clone().arrayBuffer();
		return response;
	} catch (error) {
		if (controller.signal.aborted) {
			throw new CloudError('timeout', `Request timed out after ${timeoutMs} ms.`, { cause: error });
		}
		// fetch() rejects with a TypeError when the network is unreachable.
		throw new CloudError('offline', 'Network request failed.', { cause: error });
	} finally {
		clearTimeout(timer);
	}
}
