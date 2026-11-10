// WebRTC normally makes a new certificate per connection, which would change this device's fingerprint every time and
// make a saved fingerprint useless. So one is kept for the device. IndexedDB, because a certificate's private key cannot
// be exported to SQLite; it can only be stored as an opaque object.

const DB_NAME = 'bmp-webrtc';
const STORE = 'certificates';
const KEY = 'device';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function openStore(): Promise<IDBDatabase> {
	const request = indexedDB.open(DB_NAME, 1);
	request.onupgradeneeded = () => request.result.createObjectStore(STORE);
	return result(request);
}

const generate = () => RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: YEAR_MS } as AlgorithmIdentifier);

// shortcut: browsers cap a certificate at one year, so once a year each device must be paired by QR with the others again.
// Upgrade by announcing the new fingerprint over a live link if that yearly scan proves annoying.
export async function deviceCertificate(): Promise<RTCCertificate> {
	let db: IDBDatabase;
	try {
		db = await openStore();
	} catch (error) {
		console.warn('Could not open certificate storage; this pairing will not be remembered.', error);
		return generate(); // pairing by QR still works, only the automatic reconnect does not
	}
	try {
		const stored = (await result(db.transaction(STORE).objectStore(STORE).get(KEY))) as RTCCertificate | undefined;
		if (stored && stored.expires - Date.now() > RENEW_BEFORE_MS) return stored;

		const fresh = await generate();
		await result(db.transaction(STORE, 'readwrite').objectStore(STORE).put(fresh, KEY));
		return fresh;
	} finally {
		db.close();
	}
}
