import { resolve } from '$app/paths';
import { onLocalWrite } from '../db/localWrites';
import { SyncController } from './syncController';

// App-wide sync store. Read it as `$syncService` and call `syncService.syncNow()` / `requestSync()`.
export const syncService = new SyncController({
	// Register this exact URL (including any BASE_PATH) as a redirect URI in the Dropbox app console.
	redirectUri: () => new URL(resolve('/settings'), globalThis.location.origin).href
});

// Every committed local write schedules a debounced sync.
onLocalWrite(() => syncService.requestSync());
