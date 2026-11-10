import { normalizeWebDavUrl, validateWebDavUsername } from './cloud/webdav';

// User-editable sync configuration, kept in localStorage next to the device identity.
// shortcut: the password is stored unencrypted because an encrypted one would need a passphrase at every launch; use the Credential Management API if browsers ever allow it for WebDAV.
export interface SyncSettings {
	// Empty until the user sets up WebDAV.
	webdavUrl: string;
	username: string;
	password: string;
	// Folder under the WebDAV address that holds this shop's packets.
	folderPath: string;
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
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

function normalizeSettings(settings: SyncSettings): SyncSettings {
	const username = settings.username.trim();
	validateWebDavUsername(username);
	return {
		webdavUrl: settings.webdavUrl.trim() ? normalizeWebDavUrl(settings.webdavUrl) : '',
		username,
		password: settings.password, // never trimmed: spaces can be part of a password
		folderPath: normalizeFolderPath(settings.folderPath)
	};
}

const DEFAULTS: SyncSettings = { webdavUrl: '', username: '', password: '', folderPath: DEFAULT_FOLDER_PATH };

export function loadSyncSettings(storage: SettingsStorage = localStorage): SyncSettings {
	const raw = storage.getItem(SETTINGS_KEY);
	if (!raw) return DEFAULTS;

	try {
		const parsed = JSON.parse(raw) as Partial<SyncSettings>;
		const text = (value: unknown) => (typeof value === 'string' ? value : '');
		return normalizeSettings({
			webdavUrl: text(parsed.webdavUrl),
			username: text(parsed.username),
			password: text(parsed.password),
			folderPath: text(parsed.folderPath)
		});
	} catch {
		return DEFAULTS; // corrupted entry: start clean rather than block the app
	}
}

// Validates and persists; returns the normalized settings that were stored.
export function saveSyncSettings(settings: SyncSettings, storage: SettingsStorage = localStorage): SyncSettings {
	const normalized = normalizeSettings(settings);
	storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
	return normalized;
}
