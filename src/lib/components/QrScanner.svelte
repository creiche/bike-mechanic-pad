<script lang="ts">
	import jsQR from 'jsqr';
	import { onMount } from 'svelte';

	let { onscan }: { onscan: (text: string) => void } = $props();

	const SCAN_INTERVAL_MS = 200;
	const MAX_SCAN_WIDTH = 640; // plenty for a code this small, and far cheaper on a phone

	let video: HTMLVideoElement;
	let unavailable = $state(false);

	onMount(() => {
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d', { willReadFrequently: true });
		let stream: MediaStream | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;

		const scan = () => {
			if (stopped || !context) return;
			if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
				const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
				canvas.width = Math.round(video.videoWidth * scale);
				canvas.height = Math.round(video.videoHeight * scale);
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
				const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
				const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
				if (found?.data) onscan(found.data);
			}
			timer = setTimeout(scan, SCAN_INTERVAL_MS);
		};

		// mediaDevices is undefined outside a secure context.
		const starting = navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }) ?? Promise.reject();
		starting
			.then((opened) => {
				if (stopped) return opened.getTracks().forEach((track) => track.stop());
				stream = opened;
				video.srcObject = opened;
				return video.play().then(scan);
			})
			.catch(() => {
				unavailable = true;
			});

		return () => {
			stopped = true;
			clearTimeout(timer);
			stream?.getTracks().forEach((track) => track.stop());
		};
	});
</script>

{#if unavailable}
	<p class="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">The camera is not available. Allow camera access for this site, or paste the code below.</p>
{/if}
<!-- svelte-ignore a11y_media_has_caption -->
<video bind:this={video} playsinline muted class="mx-auto aspect-square w-full max-w-72 rounded-md bg-black object-cover" class:hidden={unavailable}></video>
