import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER_PATH, loadSyncSettings, normalizeFolderPath, saveSyncSettings } from './settings';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
	const data = new Map<string, string>();
	return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const DEFAULTS = { webdavUrl: '', username: '', password: '', folderPath: DEFAULT_FOLDER_PATH };
const VALID = { webdavUrl: ' https://nas.example/dav/ ', username: ' shop ', password: ' spaced pass ', folderPath: 'Shop' };

describe('normalizeFolderPath', () => {
	it('adds a leading slash and trims slashes and spaces', () => {
		expect(normalizeFolderPath('Shop')).toBe('/Shop');
		expect(normalizeFolderPath('  /Shop/Sync/ ')).toBe('/Shop/Sync');
	});

	it('falls back to the default when empty', () => {
		expect(normalizeFolderPath('  / ')).toBe(DEFAULT_FOLDER_PATH);
	});

	it('rejects traversal, empty segments and backslashes', () => {
		expect(() => normalizeFolderPath('/a/../b')).toThrow();
		expect(() => normalizeFolderPath('/a//b')).toThrow();
		expect(() => normalizeFolderPath('a\\b')).toThrow();
	});
});

describe('sync settings storage', () => {
	it('returns defaults when nothing is stored or the entry is corrupt', () => {
		const storage = memoryStorage();
		expect(loadSyncSettings(storage)).toEqual(DEFAULTS);
		storage.setItem('bmp.sync.settings', '{nope');
		expect(loadSyncSettings(storage)).toEqual(DEFAULTS);
	});

	it('round-trips normalized values, leaving the password exactly as typed', () => {
		const storage = memoryStorage();
		const saved = saveSyncSettings(VALID, storage);
		expect(saved).toEqual({ webdavUrl: 'https://nas.example/dav', username: 'shop', password: ' spaced pass ', folderPath: '/Shop' });
		expect(loadSyncSettings(storage)).toEqual(saved);
	});

	it('keeps the folder from older Dropbox settings and ignores the rest', () => {
		const storage = memoryStorage();
		storage.setItem('bmp.sync.settings', JSON.stringify({ appKey: 'old', folderPath: '/MyShop' }));
		expect(loadSyncSettings(storage)).toEqual({ ...DEFAULTS, folderPath: '/MyShop' });
	});

	it('refuses an unsafe address or impossible username without storing anything', () => {
		const storage = memoryStorage();
		expect(() => saveSyncSettings({ ...VALID, webdavUrl: 'http://nas.local/dav' }, storage)).toThrow(/https/);
		expect(() => saveSyncSettings({ ...VALID, username: 'a:b' }, storage)).toThrow(/cannot contain/);
		expect(storage.getItem('bmp.sync.settings')).toBeNull();
	});
});
