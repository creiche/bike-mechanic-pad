import { onLocalWrite } from '../db/localWrites';
import { SyncController } from './syncController';

// App-wide sync store. Read it as `$syncService` and call `syncService.syncNow()` / `requestSync()`.
export const syncService = new SyncController();

// Every committed local write schedules a debounced sync.
onLocalWrite(() => syncService.requestSync());
