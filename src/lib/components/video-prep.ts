import { conversionPlan, type VideoFacts } from '#lib/domain/video-specs.js';

/**
 * Video checks and conversion in the browser, before anything reaches R2.
 *
 * Mediabunny reads and re-encodes with WebCodecs, so the platforms get a file
 * they accept (H.264/AAC MP4, see UPLOAD_TARGET) without a server-side
 * ffmpeg: a Worker has no WebCodecs and too little CPU time to transcode.
 * It is imported on first use, so the composer's bundle does not carry it
 * for the many posts that have no video.
 */
const loadMediabunny = () => import('mediabunny');

/** Containers the picker offers; anything else Mediabunny reads is converted too. */
export const VIDEO_INPUT_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];

export class VideoPrepError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VideoPrepError';
	}
}

export async function probeVideo(file: Blob): Promise<VideoFacts> {
	const { Input, BlobSource, ALL_FORMATS } = await loadMediabunny();
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const format = await input.getFormat().catch(() => null);
		const video = format ? await input.getPrimaryVideoTrack() : null;
		if (!format || !video)
			throw new VideoPrepError('That file is not a video this browser can read');
		const audio = await input.getPrimaryAudioTrack();
		// A short sample is enough for the frame rate and keeps a long file fast.
		const stats = await video.computePacketStats(100);
		return {
			container: format.mimeType.replace(/^video\//, '').toLowerCase(),
			size: file.size,
			duration: await input.computeDuration(),
			width: await video.getDisplayWidth(),
			height: await video.getDisplayHeight(),
			rotation: await video.getRotation(),
			videoCodec: await video.getCodec(),
			audioCodec: audio ? await audio.getCodec() : null,
			frameRate: stats.averagePacketRate
		};
	} finally {
		input.dispose();
	}
}

export type PreparedVideo = {
	file: File;
	facts: VideoFacts;
	converted: boolean;
};

/**
 * The file to upload: the original when it already fits UPLOAD_TARGET,
 * otherwise an H.264/AAC MP4 re-encoded to fit. `onProgress` gets 0..1 while
 * a conversion runs; aborting `signal` cancels it.
 */
export async function prepareVideo(
	file: File,
	opts: { onProgress?: (progress: number) => void; signal?: AbortSignal } = {}
): Promise<PreparedVideo> {
	const facts = await probeVideo(file);
	const plan = conversionPlan(facts);
	if (!plan.needed) return { file, facts, converted: false };
	if ('impossible' in plan) throw new VideoPrepError(plan.impossible);

	const mb = await loadMediabunny();
	const canVideo = await mb.canEncodeVideo('avc', {
		width: plan.width,
		height: plan.height,
		bitrate: plan.videoBitrate
	});
	const canAudio = !facts.audioCodec || (await mb.canEncodeAudio('aac'));
	if (!canVideo || !canAudio) {
		throw new VideoPrepError(
			'This browser cannot convert the video to H.264 MP4 — try Chrome or Edge, or export it as H.264 MP4 first'
		);
	}

	const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
	const output = new mb.Output({
		// Instagram wants the moov box at the front; in-memory is fine at 95MB.
		format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
		target: new mb.BufferTarget()
	});
	try {
		const conversion = await mb.Conversion.init({
			input,
			output,
			tracks: 'primary',
			video: {
				codec: 'avc',
				width: plan.width,
				height: plan.height,
				fit: 'contain',
				allowTransformationMetadata: false,
				bitrate: plan.videoBitrate,
				...(plan.frameRate ? { frameRate: plan.frameRate } : {}),
				forceTranscode: true
			},
			audio: { codec: 'aac', bitrate: plan.audioBitrate }
		});
		if (!conversion.isValid) {
			throw new VideoPrepError(
				'This browser cannot convert this video — export it as H.264 MP4 first'
			);
		}
		const abort = () => void conversion.cancel();
		opts.signal?.addEventListener('abort', abort, { once: true });
		if (opts.onProgress) conversion.onProgress = (p) => opts.onProgress?.(Math.min(1, p));
		try {
			await conversion.execute();
		} finally {
			opts.signal?.removeEventListener('abort', abort);
		}
		const buffer = output.target.buffer;
		if (!buffer) throw new VideoPrepError('The conversion produced no file');
		const name = file.name.replace(/\.[^.]+$/, '') + '.mp4';
		const converted = new File([buffer], name, { type: 'video/mp4' });
		return { file: converted, facts: await probeVideo(converted), converted: true };
	} catch (err) {
		if (err instanceof mb.ConversionCanceledError)
			throw new VideoPrepError('Video conversion cancelled');
		throw err;
	} finally {
		input.dispose();
	}
}

/**
 * A still frame for the composer's preview, as an object URL the caller
 * revokes. Null when the browser cannot decode the video: the preview then
 * stays a plain player, which is all it was before.
 */
export async function videoCover(file: Blob, atSeconds = 1): Promise<string | null> {
	const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await loadMediabunny();
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode())) return null;
		const duration = await input.computeDuration();
		const sink = new CanvasSink(track, { width: 320 });
		// Past the first second where there is one: many clips open on black.
		const frame = await sink.getCanvas(Math.min(atSeconds, Math.max(0, duration / 2)));
		if (!frame) return null;
		const canvas = frame.canvas;
		const blob =
			'convertToBlob' in canvas
				? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
				: await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
		return blob ? URL.createObjectURL(blob) : null;
	} catch {
		return null;
	} finally {
		input.dispose();
	}
}
