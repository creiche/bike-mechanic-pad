import { describe, expect, it } from 'vitest';
import { fetchWithTimeout, type FetchLike } from './http';

describe('fetchWithTimeout', () => {
	it('times out when the body stalls after the headers arrive', async () => {
		const stalled = (async (_url: string, init: RequestInit) =>
			new Response(
				new ReadableStream({
					start(controller) {
						init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
					}
				})
			)) as unknown as FetchLike;

		await expect(fetchWithTimeout(stalled, 'https://example.test', {}, 5)).rejects.toMatchObject({ kind: 'timeout' });
	});

	it('leaves the body readable for the caller', async () => {
		const ok = (async () => new Response('file body')) as unknown as FetchLike;
		const response = await fetchWithTimeout(ok, 'https://example.test', {});
		expect(await response.text()).toBe('file body');
	});
});
