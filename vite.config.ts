import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const opfsHeaders = {
	name: 'opfs-headers',
	configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
		server.middlewares.use((_, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			next();
		});
	},
	configurePreviewServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
		server.middlewares.use((_, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			next();
		});
	}
};

export default defineConfig({
	plugins: [
		opfsHeaders,
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Set BASE_PATH=/repo-name when hosted under a sub-path (GitHub Pages project site).
			// relative:false = absolute asset URLs, so the cached shell works when served at any deep link.
			paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}`, relative: false },

			// Static single-page app: no server, so the same build runs from a static host, as a PWA, or inside Tauri.
			// Unknown paths fall back to index.html and the client router takes over.
			adapter: adapter({ fallback: 'index.html' })
		}),
		tailwindcss()

	],
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		}
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		}
	},
	optimizeDeps: {
		// Exclude sqlite-wasm from Vite pre-bundling so WASM assets load dynamically.
		exclude: ['@sqlite.org/sqlite-wasm']
	}
});
