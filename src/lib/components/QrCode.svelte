<script lang="ts">
	import qrcode from 'qrcode-generator';

	let { value, label }: { value: string; label: string } = $props();

	const QUIET_ZONE = 4; // modules of blank margin that scanners need around the code

	const code = $derived.by(() => {
		const qr = qrcode(0, 'M');
		qr.addData(value, 'Byte');
		qr.make();
		const count = qr.getModuleCount();
		let path = '';
		for (let row = 0; row < count; row++) {
			for (let column = 0; column < count; column++) {
				if (qr.isDark(row, column)) path += `M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
			}
		}
		return { size: count + QUIET_ZONE * 2, path };
	});
</script>

<!-- Black on white even in dark mode: scanners are built for it, and a bright code reads best in a dim shop. -->
<svg viewBox="0 0 {code.size} {code.size}" role="img" aria-label={label} shape-rendering="crispEdges" class="mx-auto w-full max-w-72 rounded-md bg-white">
	<path d={code.path} fill="#000" />
</svg>
