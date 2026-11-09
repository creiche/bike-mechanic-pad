// Stable identity of this install, sent in every packet so peers can tell who wrote what.
export interface DeviceIdentity {
	deviceId: string;
	deviceName: string;
}

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const DEVICE_ID_KEY = 'bmp.sync.deviceId';
const DEVICE_NAME_KEY = 'bmp.sync.deviceName';

// The id is generated once and kept; the name defaults to one derived from the id until the user sets it.
export function loadDeviceIdentity(storage: DeviceStorage = localStorage): DeviceIdentity {
	let deviceId = storage.getItem(DEVICE_ID_KEY);
	if (!deviceId) {
		deviceId = crypto.randomUUID();
		storage.setItem(DEVICE_ID_KEY, deviceId);
	}

	return {
		deviceId,
		deviceName: storage.getItem(DEVICE_NAME_KEY) ?? `Device ${deviceId.slice(0, 8)}`
	};
}

export function saveDeviceName(deviceName: string, storage: DeviceStorage = localStorage): void {
	const trimmed = deviceName.trim();
	if (!trimmed) throw new Error('Device name is required.');
	storage.setItem(DEVICE_NAME_KEY, trimmed);
}
