/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';
import { filesLoadedByWorker } from './lib/offline/workerFiles';

// The ONE service worker for the app. It does two jobs:
//  1. Offline: precache the whole app shell (HTML, JS, CSS, WASM) so reloads work with no network.
//  2. Isolation: add COOP/COEP headers to everything it serves, so OPFS works on hosts that cannot
//     send headers (GitHub Pages). This replaces the old coi-serviceworker.js, which would clash
//     with this worker because a scope can have only one.
const sw = self as unknown as ServiceWorkerGlobalScope;
// The worker lives at <base>/service-worker.js, so its scope is the base path.
const base = new URL(sw.registration.scope).pathname.replace(/\/$/, '');
const CACHE = `shell-${version}`;
const SHELL = `${base}/`; // SPA fallback page (hosts serve index.html here): every navigation gets it
// Manifest paths are relative to the base path.
const ASSETS = [
	...immutable.map((f) => base + f.path),
	...assets.map((f) => base + f.path).filter((f) => !/\/_(headers|redirects)$/.test(f)),
	SHELL
];

function isolated(res: Response): Response {
	if (res.status === 0) return res; // opaque responses cannot be rewritten
	const headers = new Headers(res.headers);
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
	headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(ASSETS);
			// The manifest lists the database worker but not sqlite's wasm and OPFS proxy, which only that worker's code names.
			const workers = ASSETS.filter((path) => /\/workers\/[^/]+\.js$/.test(path));
			const files = await Promise.all(
				workers.map(async (path) => filesLoadedByWorker(await (await cache.match(path))!.text(), new URL(path, sw.location.href).href))
			);
			await cache.addAll([...new Set(files.flat())]);
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	// Only our own GETs. Cross-origin calls (WebDAV sync) go straight to the network.
	if (request.method !== 'GET' || url.origin !== sw.location.origin) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			const hit = await cache.match(request.mode === 'navigate' ? SHELL : url.pathname);
			// shortcut: cache-first with no runtime caching; unknown same-origin URLs hit the network.
			return isolated(hit ?? (await fetch(request)));
		})()
	);
});
