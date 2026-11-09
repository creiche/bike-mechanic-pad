// User-editable sync configuration, kept in localStorage next to the device identity and OAuth tokens.
export interface SyncSettings {
	// Dropbox "App key" (OAuth client id). Public by design under PKCE.
	appKey: string;
	// Folder inside the Dropbox app folder that holds this shop's packets.
	folderPath: string;
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_FOLDER_PATH = '/BikeMechanicPadSync';
const SETTINGS_KEY = 'bmp.sync.settings';

// Accepts "Shop", "/Shop/" or "  /Shop  " and returns "/Shop". Empty input falls back to the default.
export function normalizeFolderPath(input: string): string {
	const trimmed = input.trim().replace(/^\/+|\/+$/g, '');
	if (!trimmed) return DEFAULT_FOLDER_PATH;
	if (/[\\\u0000-\u001f]/.test(trimmed) || trimmed.split('/').some((part) => part === '.' || part === '..' || part === '')) {
		throw new Error('Sync folder must be a plain path such as /BikeMechanicPadSync.');
	}
	return `/${trimmed}`;
}

export function loadSyncSettings(storage: SettingsStorage = localStorage): SyncSettings {
	const defaults: SyncSettings = { appKey: '', folderPath: DEFAULT_FOLDER_PATH };
	const raw = storage.getItem(SETTINGS_KEY);
	if (!raw) return defaults;

	try {
		const parsed = JSON.parse(raw) as Partial<SyncSettings>;
		return {
			appKey: typeof parsed.appKey === 'string' ? parsed.appKey.trim() : '',
			folderPath: typeof parsed.folderPath === 'string' ? normalizeFolderPath(parsed.folderPath) : DEFAULT_FOLDER_PATH
		};
	} catch {
		return defaults; // corrupted entry: start clean rather than block the app
	}
}

// Validates and persists; returns the normalized settings that were stored.
export function saveSyncSettings(settings: SyncSettings, storage: SettingsStorage = localStorage): SyncSettings {
	const normalized: SyncSettings = {
		appKey: settings.appKey.trim(),
		folderPath: normalizeFolderPath(settings.folderPath)
	};
	storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
	return normalized;
}
