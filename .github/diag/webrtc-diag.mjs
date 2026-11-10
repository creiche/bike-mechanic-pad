// Temporary: why do browsers on the GitHub macOS runner gather no host candidates? Remove with diag.yml.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const ipv4 = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
	(list ?? []).filter((a) => a.family === 'IPv4').map((a) => `${name}=${a.address}${a.internal ? '(internal)' : ''}`)
);
console.log('node IPv4 interfaces:', ipv4.join(' '));

// Plain UDP from Node: to our own LAN address, and to the mDNS multicast group the browsers use.
const lan = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address;
for (const [label, host, port] of [['own LAN address', lan, 9], ['mDNS multicast', '224.0.0.251', 5353]]) {
	if (!host) { console.log(`udp ${label}: no address`); continue; }
	const result = await new Promise((resolve) => {
		const s = createSocket('udp4');
		s.on('error', (e) => { s.close(); resolve(`error ${e.code}`); });
		s.bind(0, () => s.send(Buffer.from('x'), port, host, (e) => { s.close(); resolve(e ? `error ${e.code}` : 'sent'); }));
	});
	console.log(`udp ${label} (${host}): ${result}`);
}

const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>d</title>'); });
await new Promise((r) => server.listen(4180, r));

const gather = (page) => page.evaluate(async () => {
	const pc = new RTCPeerConnection({ iceServers: [] });
	const lines = [];
	pc.onicecandidate = (e) => lines.push(e.candidate ? e.candidate.candidate : 'END');
	pc.createDataChannel('x');
	await pc.setLocalDescription();
	await new Promise((r) => {
		const t = setTimeout(r, 8000);
		pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } };
	});
	const out = { state: pc.iceGatheringState, lines };
	pc.close();
	return out;
});

for (const [name, type, options] of [
	['chromium', chromium, {}],
	['chromium mdns-off', chromium, { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }],
	['chromium loopback-allowed', chromium, { args: ['--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] }],
	['webkit', webkit, {}]
]) {
	const browser = await type.launch(options);
	const page = await (await browser.newContext()).newPage();
	await page.goto('http://localhost:4180/');
	const t0 = Date.now();
	const { state, lines } = await gather(page);
	console.log(`${name}: gathering=${state} after ${Date.now() - t0} ms, ${lines.length} events`);
	for (const line of lines) console.log(`  ${line}`);
	await browser.close();
}
server.close();
