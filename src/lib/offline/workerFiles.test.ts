import { describe, expect, it } from 'vitest';
import { filesLoadedByWorker } from './workerFiles';

const WORKER = 'https://shop.test/pad/_app/immutable/workers/sqlite.worker-a.js';

describe('filesLoadedByWorker', () => {
	it('finds the wasm and proxy named in a bundled worker, once each', () => {
		const script =
			'new URL(`/pad/_app/immutable/workers/assets/sqlite3-x.wasm`,``+self.location.href);' +
			'fetch("/pad/_app/immutable/workers/assets/sqlite3-x.wasm");' +
			"new URL('/pad/_app/immutable/workers/assets/sqlite3-opfs-async-proxy-y.js',self.location.href)";
		expect(filesLoadedByWorker(script, WORKER)).toEqual([
			'https://shop.test/pad/_app/immutable/workers/assets/sqlite3-x.wasm',
			'https://shop.test/pad/_app/immutable/workers/assets/sqlite3-opfs-async-proxy-y.js'
		]);
	});

	it('resolves paths relative to the worker script', () => {
		expect(filesLoadedByWorker('new URL("../workers/assets/a.wasm",import.meta.url)', WORKER)).toEqual([
			'https://shop.test/pad/_app/immutable/workers/assets/a.wasm'
		]);
	});

	it('finds nothing in a script with no worker assets', () => {
		expect(filesLoadedByWorker('const a = "/_app/immutable/chunks/b.js"', WORKER)).toEqual([]);
	});
});
