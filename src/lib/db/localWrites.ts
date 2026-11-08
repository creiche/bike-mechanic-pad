// Decouples repositories from the sync layer: they announce committed local writes, sync subscribes.
type Listener = () => void;

const listeners = new Set<Listener>();

export function onLocalWrite(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// Call only after COMMIT. A failing listener must never fail the write that already succeeded.
export function notifyLocalWrite(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			console.warn('Local-write listener failed.', error);
		}
	}
}
