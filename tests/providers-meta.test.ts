import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	IG_PENDING_CHILDREN,
	IG_PENDING_CONTAINER,
	instagramAuthorizeUrl,
	instagramExchangeCode,
	instagramProvider
} from '#lib/server/providers/instagram.js';
import {
	facebookAuthorizeUrl,
	facebookExchangeCode,
	facebookProvider
} from '#lib/server/providers/facebook.js';
import { metaUpstreamError } from '#lib/server/providers/meta-graph.js';
import { isAuthFailure, isFailureRetryable } from '#lib/server/publish.js';
import {
	ProviderError,
	type FetchLike,
	type MediaAttachment,
	type PublishCheckpoint
} from '#lib/server/providers/types.js';
import { metaMediaProblem } from '#lib/domain/media-limits.js';
import { humanizeError } from '#lib/domain/human-error.js';

type Call = { method: string; url: string; params: Record<string, string> };

/** Records every request and answers from the first handler whose key the URL contains. */
function graph(handlers: Record<string, (call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request = new Request(String(input), init);
		let params: Record<string, string> = Object.fromEntries(new URL(request.url).searchParams);
		if (request.method === 'POST') {
			const type = request.headers.get('content-type') ?? '';
			if (type.startsWith('multipart/form-data')) {
				const form = await request.formData();
				params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
			} else {
				params = Object.fromEntries(new URLSearchParams(await request.text()));
			}
		}
		const call = { method: request.method, url: request.url, params };
		calls.push(call);
		for (const [key, handler] of Object.entries(handlers)) {
			if (request.url.includes(key)) return handler(call);
		}
		return new Response(`No mock for ${request.url}`, { status: 404 });
	};
	return { fetchImpl, calls };
}

const jpeg = (key: string, alt?: string): MediaAttachment => ({
	storageKey: key,
	mime: 'image/jpeg',
	size: 1000,
	...(alt ? { alt } : {})
});
const mp4 = (key: string): MediaAttachment => ({ storageKey: key, mime: 'video/mp4', size: 5000 });
const signer = (key: string) => `https://media.test/${key}`;

function checkpoints() {
	const seen: PublishCheckpoint[] = [];
	return { seen, checkpoint: (state: PublishCheckpoint) => void seen.push(state) };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('instagram validation', () => {
	it('needs media, JPEG images and at most ten items', () => {
		const codes = (content: Parameters<typeof instagramProvider.validate>[0]) =>
			instagramProvider.validate(content).map((i) => i.code);
		expect(codes({ text: 'words only' })).toEqual(['media_required']);
		expect(codes({ text: '', media: [{ ...jpeg('a'), mime: 'image/png' }] })).toEqual([
			'bad_media'
		]);
		expect(codes({ text: '', media: [{ ...mp4('v'), mime: 'video/quicktime' }] })).toEqual([
			'bad_media'
		]);
		const eleven = Array.from({ length: 11 }, (_, i) => jpeg(`k${i}`));
		expect(codes({ text: '', media: eleven })).toEqual(['max_images']);
		expect(codes({ text: '', media: [jpeg('a'), mp4('v')] })).toEqual([]);
	});

	it('counts the caption and hashtags of the whole flattened thread', () => {
		const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
		const issues = instagramProvider.validate({
			text: '',
			thread: [
				{ text: tags.slice(0, 40), media: [jpeg('a')] },
				{ text: tags.slice(40), media: [jpeg('b')] }
			]
		});
		expect(issues.map((i) => i.message)).toEqual([expect.stringMatching(/max 30 hashtags/)]);
		expect(
			instagramProvider.validate({ text: 'a'.repeat(2201), media: [jpeg('a')] })[0]?.code
		).toBe('max_length');
	});
});

describe('instagramProvider.publish', () => {
	const creds = { accessToken: 'ig-token', instagramUserId: '1784' };

	it('publishes one image with its caption and alt text, then links the permalink', async () => {
		const { fetchImpl, calls } = graph({
			'/1784/media_publish': () => Response.json({ id: 'media-1' }),
			'/1784/media': () => Response.json({ id: 'container-1' }),
			'/container-1?': () => Response.json({ status_code: 'FINISHED' }),
			'/media-1?': () => Response.json({ permalink: 'https://www.instagram.com/p/ABC/' })
		});
		const { seen, checkpoint } = checkpoints();
		const result = await instagramProvider.publish(
			{ text: 'New trailer', media: [jpeg('shot.jpg', 'A knight')] },
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor: signer, checkpoint }
		);
		expect(result).toEqual({
			remotePostId: 'media-1',
			remoteUrl: 'https://www.instagram.com/p/ABC/',
			segmentIds: ['media-1']
		});
		const created = calls.find((c) => c.url.includes('/1784/media?') || c.url.endsWith('/media'));
		expect(created?.params).toMatchObject({
			image_url: 'https://media.test/shot.jpg',
			caption: 'New trailer',
			alt_text: 'A knight'
		});
		expect(calls.find((c) => c.url.includes('media_publish'))?.params.creation_id).toBe(
			'container-1'
		);
		// The container is on record before the publish call, so an abort
		// between the two resumes it instead of uploading a second post.
		expect(seen).toEqual([
			{ segmentIds: ['container-1'], segmentCids: [IG_PENDING_CONTAINER], remoteUrl: null },
			{ segmentIds: ['media-1'], remoteUrl: null }
		]);
	});

	it('posts a lone MP4 as a Reel', async () => {
		const { fetchImpl, calls } = graph({
			'/media_publish': () => Response.json({ id: 'reel-1' }),
			'/1784/media': () => Response.json({ id: 'c-reel' }),
			'/c-reel?': () => Response.json({ status_code: 'FINISHED' }),
			'/reel-1?': () => Response.json({})
		});
		await instagramProvider.publish(
			{ text: 'Gameplay', media: [mp4('clip.mp4')] },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor: signer
			}
		);
		expect(calls[0].params).toMatchObject({
			media_type: 'REELS',
			video_url: 'https://media.test/clip.mp4',
			caption: 'Gameplay'
		});
		expect(calls[0].params.image_url).toBeUndefined();
	});

	it('builds a mixed carousel from every segment, captioning only the parent', async () => {
		let n = 0;
		const { fetchImpl, calls } = graph({
			'/media_publish': () => Response.json({ id: 'carousel-1' }),
			'/1784/media': () => Response.json({ id: `c${++n}` }),
			'?fields=status_code': () => Response.json({ status_code: 'FINISHED' }),
			'/carousel-1?': () => Response.json({})
		});
		const { seen, checkpoint } = checkpoints();
		await instagramProvider.publish(
			{
				text: '',
				thread: [
					{ text: 'Part one', media: [jpeg('a.jpg'), jpeg('b.jpg')] },
					{ text: 'Part two', media: [mp4('c.mp4')] }
				]
			},
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor: signer, checkpoint }
		);
		const creates = calls.filter((c) => c.method === 'POST' && !c.url.includes('media_publish'));
		expect(creates.map((c) => c.params.is_carousel_item)).toEqual([
			'true',
			'true',
			'true',
			undefined
		]);
		expect(creates[2].params).toMatchObject({
			media_type: 'VIDEO',
			video_url: 'https://media.test/c.mp4'
		});
		expect(creates.slice(0, 3).every((c) => c.params.caption === undefined)).toBe(true);
		expect(creates[3].params).toMatchObject({
			media_type: 'CAROUSEL',
			children: 'c1,c2,c3',
			caption: 'Part one\n\nPart two'
		});
		expect(seen[0]).toEqual({
			segmentIds: ['c1', 'c2', 'c3'],
			segmentCids: [IG_PENDING_CHILDREN],
			remoteUrl: null
		});
	});

	it('does not publish again when the container it resumes already went live', async () => {
		const { fetchImpl, calls } = graph({
			'/old-container?': () => Response.json({ status_code: 'PUBLISHED' })
		});
		const result = await instagramProvider.publish(
			{ text: 'x', media: [jpeg('a.jpg')] },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor: signer,
				resume: { segmentIds: ['old-container'], segmentCids: [IG_PENDING_CONTAINER] }
			}
		);
		expect(result.segmentIds).toEqual(['']);
		expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
	});

	it('publishes the resumed container instead of uploading the media again', async () => {
		const { fetchImpl, calls } = graph({
			'/media_publish': () => Response.json({ id: 'media-9' }),
			'/old-container?': () => Response.json({ status_code: 'FINISHED' }),
			'/media-9?': () => Response.json({})
		});
		const result = await instagramProvider.publish(
			{ text: 'x', media: [mp4('a.mp4')] },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor: signer,
				resume: { segmentIds: ['old-container'], segmentCids: [IG_PENDING_CONTAINER] }
			}
		);
		expect(result.remotePostId).toBe('media-9');
		const posts = calls.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0].params.creation_id).toBe('old-container');
	});

	it('starts over when the resumed container expired', async () => {
		const { fetchImpl, calls } = graph({
			'/media_publish': () => Response.json({ id: 'media-2' }),
			'/1784/media': () => Response.json({ id: 'fresh' }),
			'/old-container?': () => Response.json({ status_code: 'EXPIRED' }),
			'/fresh?': () => Response.json({ status_code: 'FINISHED' }),
			'/media-2?': () => Response.json({})
		});
		await instagramProvider.publish(
			{ text: 'x', media: [jpeg('a.jpg')] },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor: signer,
				resume: { segmentIds: ['old-container'], segmentCids: [IG_PENDING_CONTAINER] }
			}
		);
		expect(calls.find((c) => c.url.includes('media_publish'))?.params.creation_id).toBe('fresh');
	});

	it('returns a checkpointed media id without calling Instagram', async () => {
		const { fetchImpl, calls } = graph({});
		const result = await instagramProvider.publish(
			{ text: 'x', media: [jpeg('a.jpg')] },
			creds,
			undefined,
			fetchImpl,
			{ resume: { segmentIds: ['media-1'], remoteUrl: 'https://www.instagram.com/p/X/' } }
		);
		expect(result).toEqual({
			remotePostId: 'media-1',
			remoteUrl: 'https://www.instagram.com/p/X/',
			segmentIds: ['media-1']
		});
		expect(calls).toEqual([]);
	});

	it('reports a lost publish answer as unconfirmed, with the container on record', async () => {
		const { fetchImpl } = graph({
			'/media_publish': () => {
				throw new TypeError('network connection lost');
			},
			'/1784/media': () => Response.json({ id: 'container-1' }),
			'/container-1?': () => Response.json({ status_code: 'FINISHED' })
		});
		const { seen, checkpoint } = checkpoints();
		const failure = await instagramProvider
			.publish({ text: 'x', media: [jpeg('a.jpg')] }, creds, undefined, fetchImpl, {
				mediaUrlFor: signer,
				checkpoint
			})
			.catch((e) => e);
		expect(failure).toBeInstanceOf(ProviderError);
		expect(failure.code).toBe('unconfirmed');
		expect(failure.message).toMatch(/Instagram did not confirm the post/);
		expect(seen.at(-1)).toEqual({
			segmentIds: ['container-1'],
			segmentCids: [IG_PENDING_CONTAINER],
			remoteUrl: null
		});
	});

	it('parks a video that is still processing as retryable, keeping its container', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = graph({
			'/1784/media': () => Response.json({ id: 'slow' }),
			'/slow?': () => Response.json({ status_code: 'IN_PROGRESS' })
		});
		const { seen, checkpoint } = checkpoints();
		const pending = instagramProvider
			.publish({ text: 'x', media: [mp4('big.mp4')] }, creds, undefined, fetchImpl, {
				mediaUrlFor: signer,
				checkpoint
			})
			.catch((e) => e);
		await vi.runAllTimersAsync();
		const failure = await pending;
		expect(failure.message).toMatch(/still processing/);
		expect(isFailureRetryable(failure, failure.message)).toBe(true);
		expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);
		expect(seen).toEqual([
			{ segmentIds: ['slow'], segmentCids: [IG_PENDING_CONTAINER], remoteUrl: null }
		]);
	});

	it('treats a container Instagram refused as permanent, and a dead token as auth', async () => {
		const refused = graph({
			'/1784/media': () => Response.json({ id: 'bad' }),
			'/bad?': () =>
				Response.json({ status_code: 'ERROR', status: 'Error: unsupported aspect ratio' })
		});
		const failure = await instagramProvider
			.publish({ text: 'x', media: [jpeg('a.jpg')] }, creds, undefined, refused.fetchImpl, {
				mediaUrlFor: signer
			})
			.catch((e) => e);
		expect(failure.message).toMatch(/aspect ratio/);
		expect(isFailureRetryable(failure, failure.message)).toBe(false);
		expect(isAuthFailure(failure, failure.message)).toBe(false);

		const expired = graph({
			'/1784/media': () =>
				Response.json(
					{
						error: { message: 'Error validating access token', type: 'OAuthException', code: 190 }
					},
					{ status: 400 }
				)
		});
		const authFailure = await instagramProvider
			.publish({ text: 'x', media: [jpeg('a.jpg')] }, creds, undefined, expired.fetchImpl, {
				mediaUrlFor: signer
			})
			.catch((e) => e);
		expect(isAuthFailure(authFailure, authFailure.message)).toBe(true);
		expect(humanizeError(authFailure.message)).toMatch(/^Instagram refused/);
	});
});

describe('instagram tokens', () => {
	const day = 24 * 60 * 60 * 1000;

	it('leaves a token with more than a week left alone', async () => {
		const { fetchImpl, calls } = graph({});
		const creds = { accessToken: 't', expiresAt: Date.now() + 30 * day };
		expect(await instagramProvider.refreshIfNeeded!(creds, fetchImpl)).toBe(creds);
		expect(calls).toEqual([]);
	});

	it('refreshes a token close to expiry and stores the new expiry', async () => {
		const { fetchImpl, calls } = graph({
			refresh_access_token: () => Response.json({ access_token: 'new', expires_in: 5_184_000 })
		});
		const refreshed = await instagramProvider.refreshIfNeeded!(
			{ accessToken: 'old', expiresAt: Date.now() + 2 * day },
			fetchImpl
		);
		expect(refreshed.accessToken).toBe('new');
		expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 59 * day);
		expect(calls[0].params.grant_type).toBe('ig_refresh_token');
	});

	it('keeps a still-valid token Instagram will not refresh yet, and expires a dead one', async () => {
		const { fetchImpl } = graph({
			refresh_access_token: () => new Response('{"error":{"code":190}}', { status: 400 })
		});
		const live = { accessToken: 'young', expiresAt: Date.now() + day };
		expect(await instagramProvider.refreshIfNeeded!(live, fetchImpl)).toBe(live);
		await expect(
			instagramProvider.refreshIfNeeded!(
				{ accessToken: 'dead', expiresAt: Date.now() - day },
				fetchImpl
			)
		).rejects.toMatchObject({ code: 'auth' });
		expect(
			instagramProvider.refreshImpossibleReason!({
				accessToken: 'dead',
				expiresAt: Date.now() - day
			})
		).toMatch(/reconnect/);
	});

	it('exchanges the code for a long-lived token and the professional account id', async () => {
		const { fetchImpl, calls } = graph({
			'api.instagram.com/oauth/access_token': () =>
				Response.json({
					data: [
						{
							access_token: 'short',
							user_id: 'app-scoped',
							permissions: 'instagram_business_basic,instagram_business_content_publish'
						}
					]
				}),
			'graph.instagram.com/access_token': () =>
				Response.json({ access_token: 'long', token_type: 'bearer', expires_in: 5_183_944 }),
			'/me?fields=': () =>
				Response.json({ user_id: '1784', username: 'example.studio', name: 'Example Studio' })
		});
		const exchanged = await instagramExchangeCode(
			{
				appId: 'ig-app',
				appSecret: 'ig-secret',
				code: 'CODE#_',
				appUrl: 'https://social.example/'
			},
			fetchImpl
		);
		expect(calls[0].params).toMatchObject({
			code: 'CODE',
			redirect_uri: 'https://social.example/api/connections/instagram/callback'
		});
		expect(exchanged).toMatchObject({
			accessToken: 'long',
			instagramUserId: '1784',
			instagramUsername: 'example.studio',
			handle: '@example.studio',
			displayName: 'Example Studio'
		});
		expect(exchanged.expiresAt).toBeGreaterThan(Date.now());
	});

	it('asks Instagram for both publishing scopes', () => {
		const url = new URL(instagramAuthorizeUrl('ig-app', 'https://social.example', 'STATE'));
		expect(url.origin).toBe('https://www.instagram.com');
		expect(url.searchParams.get('scope')).toBe(
			'instagram_business_basic,instagram_business_content_publish'
		);
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://social.example/api/connections/instagram/callback'
		);
	});
});

describe('facebook validation', () => {
	it('takes text, up to ten photos, or one video on its own', () => {
		const codes = (content: Parameters<typeof facebookProvider.validate>[0]) =>
			facebookProvider.validate(content).map((i) => i.message);
		expect(codes({ text: 'just words' })).toEqual([]);
		expect(codes({ text: '' })).toEqual(['Post needs text or media']);
		expect(codes({ text: '', media: [mp4('a'), jpeg('b')] })).toEqual([
			'Facebook video posts cannot include images'
		]);
		expect(codes({ text: '', media: [mp4('a'), mp4('b')] })).toEqual([
			'Facebook allows one video per post'
		]);
		expect(codes({ text: '', media: [{ ...jpeg('w'), mime: 'image/webp' }] })).toEqual([
			'Facebook photos must be JPEG, PNG or GIF'
		]);
		expect(codes({ text: '', media: [{ ...jpeg('big'), size: 5_000_000 }] })).toEqual([
			'Facebook allows max 4MB per photo'
		]);
	});
});

describe('facebookProvider.publish', () => {
	const creds = { accessToken: 'page-token', facebookPageId: '42' };

	it('posts text to the Page feed', async () => {
		const { fetchImpl, calls } = graph({
			'/42/feed': () => Response.json({ id: '42_100' }),
			'/42_100?': () => Response.json({ permalink_url: 'https://www.facebook.com/42/posts/100' })
		});
		const result = await facebookProvider.publish({ text: 'Hello' }, creds, undefined, fetchImpl);
		expect(result).toEqual({
			remotePostId: '42_100',
			remoteUrl: 'https://www.facebook.com/42/posts/100',
			segmentIds: ['42_100']
		});
		expect(calls[0].params).toMatchObject({ message: 'Hello', access_token: 'page-token' });
	});

	it('posts one photo with its caption and alt text', async () => {
		const { fetchImpl, calls } = graph({
			'/42/photos': () => Response.json({ id: 'photo-1', post_id: '42_200' }),
			'/42_200?': () => Response.json({})
		});
		const result = await facebookProvider.publish(
			{ text: 'Screenshot', media: [jpeg('s.jpg', 'Boss fight')] },
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor: signer }
		);
		expect(result.remotePostId).toBe('42_200');
		// The lookup failed, so the post id still makes a working link.
		expect(result.remoteUrl).toBe('https://www.facebook.com/42_200');
		expect(calls[0].params).toMatchObject({
			url: 'https://media.test/s.jpg',
			caption: 'Screenshot',
			alt_text_custom: 'Boss fight'
		});
	});

	it('attaches several unpublished photos to one feed post', async () => {
		let n = 0;
		const { fetchImpl, calls } = graph({
			'/42/photos': () => Response.json({ id: `p${++n}` }),
			'/42/feed': () => Response.json({ id: '42_300' }),
			'/42_300?': () => Response.json({})
		});
		await facebookProvider.publish(
			{
				text: '',
				thread: [
					{ text: 'One', media: [jpeg('a.jpg')] },
					{ text: 'Two', media: [jpeg('b.jpg')] }
				]
			},
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor: signer }
		);
		const photos = calls.filter((c) => c.url.includes('/42/photos'));
		expect(photos.map((c) => c.params.published)).toEqual(['false', 'false']);
		const feed = calls.find((c) => c.url.includes('/42/feed'));
		expect(feed?.params.message).toBe('One\n\nTwo');
		expect(JSON.parse(feed!.params.attached_media)).toEqual([
			{ media_fbid: 'p1' },
			{ media_fbid: 'p2' }
		]);
	});

	it('hands a video to the video host as a URL', async () => {
		const { fetchImpl, calls } = graph({
			'graph-video.facebook.com': () => Response.json({ id: 'video-1' }),
			'/video-1?': () => Response.json({ permalink_url: '/42/videos/video-1/' })
		});
		const result = await facebookProvider.publish(
			{ text: 'Launch trailer', media: [mp4('t.mp4')] },
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor: signer }
		);
		expect(calls[0].url).toContain('graph-video.facebook.com');
		expect(calls[0].params).toMatchObject({
			file_url: 'https://media.test/t.mp4',
			description: 'Launch trailer'
		});
		expect(result.remoteUrl).toBe('https://www.facebook.com/42/videos/video-1/');
	});

	it('reports a lost answer as unconfirmed only for the request that makes the post', async () => {
		const lostFeed = graph({
			'/42/feed': () => {
				throw new TypeError('socket hang up');
			}
		});
		const feedFailure = await facebookProvider
			.publish({ text: 'Hi' }, creds, undefined, lostFeed.fetchImpl)
			.catch((e) => e);
		expect(feedFailure.code).toBe('unconfirmed');

		// An unpublished photo is invisible, so losing its answer risks nothing.
		const lostPhoto = graph({
			'/42/photos': () => {
				throw new TypeError('socket hang up');
			}
		});
		const photoFailure = await facebookProvider
			.publish(
				{ text: '', media: [jpeg('a.jpg'), jpeg('b.jpg')] },
				creds,
				undefined,
				lostPhoto.fetchImpl,
				{
					mediaUrlFor: signer
				}
			)
			.catch((e) => e);
		expect(photoFailure.code).toBeUndefined();
		expect(photoFailure.message).toMatch(/socket hang up/);
	});

	it('returns a checkpointed post without posting it again', async () => {
		const { fetchImpl, calls } = graph({});
		const result = await facebookProvider.publish({ text: 'Hi' }, creds, undefined, fetchImpl, {
			resume: { segmentIds: ['42_100'] }
		});
		expect(result.remotePostId).toBe('42_100');
		expect(calls).toEqual([]);
	});
});

describe('facebook login', () => {
	it('turns every Page the person can post to into its own account', async () => {
		const { fetchImpl, calls } = graph({
			'fb_exchange_token=': () => Response.json({ access_token: 'long-user' }),
			'/oauth/access_token': () => Response.json({ access_token: 'short-user' }),
			'/me/accounts': () =>
				Response.json({
					data: [
						{
							id: '42',
							name: 'Example Studio',
							username: 'examplestudio',
							access_token: 'page-42',
							tasks: ['CREATE_CONTENT', 'MANAGE'],
							picture: { data: { url: 'https://cdn.test/42.png' } }
						},
						{ id: '43', name: 'Side Project', access_token: 'page-43', tasks: ['CREATE_CONTENT'] },
						{ id: '44', name: 'Read only', access_token: 'page-44', tasks: ['ANALYZE'] }
					]
				})
		});
		const pages = await facebookExchangeCode(
			{ appId: 'fb-app', appSecret: 'fb-secret', code: 'CODE', appUrl: 'https://social.example' },
			fetchImpl
		);
		expect(pages.map((p) => [p.facebookPageId, p.accessToken, p.handle])).toEqual([
			['42', 'page-42', '@examplestudio'],
			['43', 'page-43', undefined]
		]);
		// Page tokens come from the long-lived user token, so they do not expire.
		expect(calls.find((c) => c.url.includes('/me/accounts'))?.params.access_token).toBe(
			'long-user'
		);
	});

	it('says so when no Page was shared', async () => {
		const { fetchImpl } = graph({
			'fb_exchange_token=': () => Response.json({ access_token: 'long-user' }),
			'/oauth/access_token': () => Response.json({ access_token: 'short-user' }),
			'/me/accounts': () => Response.json({ data: [] })
		});
		await expect(
			facebookExchangeCode(
				{ appId: 'a', appSecret: 's', code: 'c', appUrl: 'https://social.example' },
				fetchImpl
			)
		).rejects.toThrow(/choose at least one Page/);
	});

	it('asks for the three Page permissions', () => {
		const url = new URL(facebookAuthorizeUrl('fb-app', 'https://social.example', 'STATE'));
		expect(url.hostname).toBe('www.facebook.com');
		expect(url.searchParams.get('scope')).toBe(
			'pages_show_list,pages_read_engagement,pages_manage_posts'
		);
	});
});

describe('metaUpstreamError', () => {
	const body = (code: number, subcode?: number) =>
		JSON.stringify({
			error: { message: 'x', code, ...(subcode ? { error_subcode: subcode } : {}) }
		});

	it('classifies by Meta code, not by HTTP status', () => {
		expect(metaUpstreamError('Instagram publish', 400, body(190)).code).toBe('auth');
		expect(metaUpstreamError('Instagram publish', 400, body(4)).code).toBe('rate_limited');
		expect(metaUpstreamError('Instagram publish', 400, body(9007)).code).toBe('upstream');
		expect(metaUpstreamError('Instagram container', 400, body(1, 2207052)).code).toBe('upstream');
		// "Missing permissions" boilerplate in an invalid-parameter error must
		// not expire the account, and retrying it cannot help.
		const param = metaUpstreamError('Facebook post', 400, body(100, 33));
		expect(param.code).toBe('forbidden');
		expect(param.message).toContain('[meta 100.33]');
	});
});

describe('metaMediaProblem', () => {
	it('checks the combined attachments of a draft for the selected Meta platforms', () => {
		expect(metaMediaProblem(['instagram'], [])).toMatch(/need an image or a video/);
		expect(metaMediaProblem(['instagram'], [{ mime: 'image/png' }])).toMatch(/JPEG/);
		expect(metaMediaProblem(['facebook'], [{ mime: 'image/png' }])).toBeNull();
		expect(metaMediaProblem(['facebook'], [{ mime: 'video/mp4' }, { mime: 'image/png' }])).toMatch(
			/cannot include images/
		);
		expect(metaMediaProblem(['x', 'bluesky'], [])).toBeNull();
	});
});
