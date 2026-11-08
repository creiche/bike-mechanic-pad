import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER_PATH, loadSyncSettings, normalizeFolderPath, saveSyncSettings } from './settings';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
	const data = new Map<string, string>();
	return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

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
		expect(loadSyncSettings(storage)).toEqual({ appKey: '', folderPath: DEFAULT_FOLDER_PATH });
		storage.setItem('bmp.sync.settings', '{nope');
		expect(loadSyncSettings(storage)).toEqual({ appKey: '', folderPath: DEFAULT_FOLDER_PATH });
	});

	it('round-trips trimmed and normalized values', () => {
		const storage = memoryStorage();
		const saved = saveSyncSettings({ appKey: '  abc ', folderPath: 'Shop' }, storage);
		expect(saved).toEqual({ appKey: 'abc', folderPath: '/Shop' });
		expect(loadSyncSettings(storage)).toEqual(saved);
	});
});
