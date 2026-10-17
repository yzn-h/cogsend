import { MAX_VIDEO_BYTES } from './media-limits';

/**
 * What the composer learns about a video before uploading it (read in the
 * browser by video-prep.ts). Dimensions are as displayed, after rotation.
 */
export type VideoFacts = {
	/** Lower-case container name as the demuxer reports it: 'mp4', 'quicktime', 'webm'… */
	container: string;
	size: number;
	duration: number;
	width: number;
	height: number;
	rotation: number;
	/** Codec family names: 'avc', 'hevc', 'vp9', 'aac', 'opus'… */
	videoCodec: string | null;
	audioCodec: string | null;
	frameRate: number;
};

export type VideoSpec = {
	label: string;
	videoCodecs: readonly string[];
	audioCodecs: readonly string[];
	minSeconds: number;
	maxSeconds: number;
	/** width / height */
	minAspect: number;
	maxAspect: number;
};

/**
 * Each platform's documented requirements for the kind of video CogSend
 * posts there. A new video platform (TikTok, YouTube) is one more entry; the
 * upload path converts to UPLOAD_TARGET, which every entry must accept.
 */
export const VIDEO_SPECS = {
	linkedin: {
		label: 'LinkedIn',
		videoCodecs: ['avc'],
		audioCodecs: ['aac'],
		minSeconds: 3,
		maxSeconds: 30 * 60,
		minAspect: 1 / 2.4,
		maxAspect: 2.4
	},
	instagram: {
		label: 'Instagram Reels',
		videoCodecs: ['avc', 'hevc'],
		audioCodecs: ['aac'],
		minSeconds: 3,
		maxSeconds: 15 * 60,
		minAspect: 0.01,
		maxAspect: 10
	},
	facebook: {
		label: 'Facebook',
		videoCodecs: ['avc', 'hevc'],
		audioCodecs: ['aac'],
		minSeconds: 1,
		maxSeconds: 240 * 60,
		minAspect: 9 / 16,
		maxAspect: 16 / 9
	}
} as const satisfies Record<string, VideoSpec>;

export type VideoPlatform = keyof typeof VIDEO_SPECS;

/**
 * The one file the composer stores, whatever is selected now: the upload is
 * reused for every platform later, so it meets the strictest of them. H.264
 * and AAC in MP4 is the only combination all of them take, and Instagram caps
 * width at 1920 and frame rate at 60.
 */
export const UPLOAD_TARGET = {
	container: 'mp4',
	videoCodec: 'avc',
	audioCodec: 'aac',
	maxLongEdge: 1920,
	maxFrameRate: 60,
	maxBytes: MAX_VIDEO_BYTES,
	audioBitrate: 128_000,
	// Plenty for 1080p H.264; higher only spends the size budget.
	maxVideoBitrate: 8_000_000,
	// Below this H.264 at these sizes turns to mush; better to say so.
	minVideoBitrate: 400_000
} as const;

// Headroom for the MP4 boxes and encoder overshoot: a bitrate is a target,
// not a ceiling.
const SIZE_HEADROOM = 0.9;

export type ConversionPlan =
	| { needed: false }
	| {
			needed: true;
			reasons: string[];
			width: number;
			height: number;
			frameRate?: number;
			videoBitrate: number;
			audioBitrate: number;
	  }
	| { needed: true; impossible: string };

// Rounded down: H.264 wants even sides, and rounding up could pass the cap.
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Whether the file has to be re-encoded before upload, and to what. */
export function conversionPlan(facts: VideoFacts): ConversionPlan {
	const reasons: string[] = [];
	if (facts.container !== UPLOAD_TARGET.container) reasons.push('container');
	if (facts.videoCodec !== UPLOAD_TARGET.videoCodec) reasons.push('video codec');
	if (facts.audioCodec && facts.audioCodec !== UPLOAD_TARGET.audioCodec)
		reasons.push('audio codec');
	if (Math.max(facts.width, facts.height) > UPLOAD_TARGET.maxLongEdge) reasons.push('resolution');
	if (facts.frameRate > UPLOAD_TARGET.maxFrameRate + 0.5) reasons.push('frame rate');
	if (facts.size > UPLOAD_TARGET.maxBytes) reasons.push('file size');
	// Rotation metadata is honoured unevenly by the platforms' players; baked
	// pixels look the same everywhere.
	if (facts.rotation % 360 !== 0) reasons.push('rotation');
	if (!reasons.length) return { needed: false };

	if (!(facts.duration > 0)) {
		return { needed: true, impossible: 'The video has no readable length' };
	}
	const scale = Math.min(1, UPLOAD_TARGET.maxLongEdge / Math.max(facts.width, facts.height));
	const audioBitrate = facts.audioCodec ? UPLOAD_TARGET.audioBitrate : 0;
	const budget = (UPLOAD_TARGET.maxBytes * 8 * SIZE_HEADROOM) / facts.duration - audioBitrate;
	const videoBitrate = Math.floor(Math.min(UPLOAD_TARGET.maxVideoBitrate, budget));
	if (videoBitrate < UPLOAD_TARGET.minVideoBitrate) {
		const minutes = Math.floor(
			(UPLOAD_TARGET.maxBytes * 8 * SIZE_HEADROOM) /
				(UPLOAD_TARGET.minVideoBitrate + audioBitrate) /
				60
		);
		return {
			needed: true,
			impossible: `The video is too long to fit in ${Math.round(UPLOAD_TARGET.maxBytes / 1_000_000)}MB — trim it to about ${minutes} minutes or less`
		};
	}
	return {
		needed: true,
		reasons,
		width: even(facts.width * scale),
		height: even(facts.height * scale),
		...(facts.frameRate > UPLOAD_TARGET.maxFrameRate + 0.5
			? { frameRate: UPLOAD_TARGET.maxFrameRate }
			: {}),
		videoBitrate,
		audioBitrate: UPLOAD_TARGET.audioBitrate
	};
}

/**
 * What a selected platform would still refuse after conversion: the things
 * re-encoding cannot fix (length, shape). One message per problem, naming the
 * platform, for the composer to show before a publish fails on it.
 */
export function videoProblems(facts: VideoFacts, platforms: Iterable<string>): string[] {
	const problems: string[] = [];
	for (const platform of platforms) {
		if (!Object.hasOwn(VIDEO_SPECS, platform)) continue;
		const spec: VideoSpec = VIDEO_SPECS[platform as VideoPlatform];
		const seconds = Math.round(facts.duration);
		if (facts.duration < spec.minSeconds) {
			problems.push(
				`${spec.label} needs at least ${spec.minSeconds}s of video (this is ${seconds}s)`
			);
		} else if (facts.duration > spec.maxSeconds) {
			problems.push(
				`${spec.label} takes up to ${formatLength(spec.maxSeconds)} of video (this is ${formatLength(seconds)})`
			);
		}
		const aspect = facts.height > 0 ? facts.width / facts.height : 0;
		if (aspect && (aspect < spec.minAspect - 0.01 || aspect > spec.maxAspect + 0.01)) {
			problems.push(`${spec.label} does not take this video's shape (${describeAspect(aspect)})`);
		}
	}
	return problems;
}

function formatLength(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s ? `${m}m ${s}s` : `${m} min`;
}

function describeAspect(aspect: number): string {
	return aspect >= 1 ? `${aspect.toFixed(2)}:1` : `1:${(1 / aspect).toFixed(2)}`;
}
