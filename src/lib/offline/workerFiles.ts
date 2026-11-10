// The URLs of the files a built worker script loads for itself: Vite emits them to workers/assets/ and only that script names them.
export function filesLoadedByWorker(script: string, scriptUrl: string): string[] {
	const paths = script.match(/[^`"'\s]*workers\/assets\/[^`"'\s]+/g) ?? [];
	return [...new Set(paths.map((path) => new URL(path, scriptUrl).href))];
}
