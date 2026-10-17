import { describe, expect, it } from 'vitest';
import {
	conversionPlan,
	UPLOAD_TARGET,
	VIDEO_SPECS,
	videoProblems,
	type VideoFacts
} from '#lib/domain/video-specs.js';
import { VIDEO_PLATFORMS } from '#lib/domain/media-limits.js';

const phoneClip: VideoFacts = {
	container: 'mp4',
	size: 40_000_000,
	duration: 30,
	width: 1080,
	height: 1920,
	rotation: 0,
	videoCodec: 'avc',
	audioCodec: 'aac',
	frameRate: 30
};

describe('conversionPlan', () => {
	it('leaves an H.264/AAC MP4 that fits every platform untouched', () => {
		expect(conversionPlan(phoneClip)).toEqual({ needed: false });
		// No audio at all is fine too.
		expect(conversionPlan({ ...phoneClip, audioCodec: null })).toEqual({ needed: false });
	});

	it('converts what a platform would refuse, keeping the shape', () => {
		const plan = conversionPlan({
			...phoneClip,
			container: 'quicktime',
			videoCodec: 'hevc',
			width: 2160,
			height: 3840,
			frameRate: 120
		});
		expect(plan).toMatchObject({
			needed: true,
			reasons: ['container', 'video codec', 'resolution', 'frame rate'],
			width: 1080,
			height: 1920,
			frameRate: 60,
			audioBitrate: UPLOAD_TARGET.audioBitrate
		});
	});

	it('picks a bitrate that lands under the size cap', () => {
		const long = { ...phoneClip, size: 400_000_000, duration: 10 * 60 };
		const plan = conversionPlan(long);
		if (!plan.needed || 'impossible' in plan) throw new Error('expected a plan');
		expect(plan.reasons).toEqual(['file size']);
		const bytes = ((plan.videoBitrate + plan.audioBitrate) * long.duration) / 8;
		expect(bytes).toBeLessThan(UPLOAD_TARGET.maxBytes);
		expect(plan.videoBitrate).toBeLessThanOrEqual(UPLOAD_TARGET.maxVideoBitrate);
	});

	it('says how long a video can be when no bitrate would fit it', () => {
		const plan = conversionPlan({ ...phoneClip, size: 2_000_000_000, duration: 60 * 60 });
		expect(plan).toMatchObject({
			needed: true,
			impossible: expect.stringMatching(/trim it to about \d+ minutes/)
		});
	});

	it('bakes rotation into the pixels and keeps even dimensions', () => {
		const plan = conversionPlan({ ...phoneClip, rotation: 90, width: 1081, height: 1921 });
		expect(plan).toMatchObject({
			needed: true,
			reasons: ['resolution', 'rotation'],
			width: 1080,
			height: 1920
		});
	});
});

describe('videoProblems', () => {
	it('names what each selected platform would still refuse', () => {
		const tiny = { ...phoneClip, duration: 2 };
		expect(videoProblems(tiny, ['instagram', 'x'])).toEqual([
			'Instagram Reels needs at least 3s of video (this is 2s)'
		]);
		const long = { ...phoneClip, duration: 20 * 60 };
		expect(videoProblems(long, ['instagram', 'linkedin', 'facebook'])).toEqual([
			'Instagram Reels takes up to 15 min of video (this is 20 min)'
		]);
		const panorama = { ...phoneClip, width: 1920, height: 600 };
		expect(videoProblems(panorama, ['linkedin', 'facebook'])).toEqual([
			"LinkedIn does not take this video's shape (3.20:1)",
			"Facebook does not take this video's shape (3.20:1)"
		]);
		expect(videoProblems(phoneClip, ['instagram', 'facebook', 'linkedin'])).toEqual([]);
	});

	it('has a spec for every platform that publishes video, all accepting the upload target', () => {
		expect(Object.keys(VIDEO_SPECS).sort()).toEqual([...VIDEO_PLATFORMS].sort());
		for (const spec of Object.values(VIDEO_SPECS)) {
			expect([
				spec.label,
				(spec.videoCodecs as readonly string[]).includes(UPLOAD_TARGET.videoCodec)
			]).toEqual([spec.label, true]);
			expect([
				spec.label,
				(spec.audioCodecs as readonly string[]).includes(UPLOAD_TARGET.audioCodec)
			]).toEqual([spec.label, true]);
		}
	});
});
