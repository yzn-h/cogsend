import { joinThreadTexts } from '#lib/domain/thread-segments.js';
import { validateInstagramText, INSTAGRAM_MAX_CHARS } from '#lib/domain/validation/text.js';
import {
	INSTAGRAM_MAX_IMAGE_BYTES,
	INSTAGRAM_MAX_ITEMS,
	MAX_VIDEO_BYTES
} from '#lib/domain/media-limits.js';
import { httpUrl, META_GRAPH_VERSION, metaUpstreamError, sleep } from './meta-graph';
import { mediaByteLength, ProviderError, unconfirmedPostError } from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishCheckpoint,
	PublishResult,
	ValidationIssue
} from './types';
import { providerFetch } from './timed-fetch';

export { INSTAGRAM_MAX_CHARS };
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const GRAPH = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
// The content publishing API takes JPEG only; PNG and WebP are refused.
const IMAGE_MIMES = new Set(['image/jpeg']);
const VIDEO_MIMES = new Set(['video/mp4']);
const REFRESH_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
// Images finish within a few seconds; a Reel can take minutes. One request
// waits ~33s, which a closed tab's waitUntil still covers. A container still
// processing after that is parked retryable with its id checkpointed, so the
// next attempt keeps waiting on the same container instead of uploading the
// video again.
const STATUS_ATTEMPTS = 12;
const STATUS_POLL_MS = 3000;
// Every status read is a subrequest (50 per invocation on Workers Free), so a
// ten-item carousel reads its children in bounded sweeps.
const CHILD_CALL_BUDGET = 24;
const STATUS_CONCURRENCY = 6;

/**
 * Checkpoint markers in `segmentCids[0]`. Instagram posts are single posts,
 * so `segmentIds` would otherwise only ever hold the published media id; the
 * marker says it holds container ids that are not live yet:
 * - pending container: created and possibly published, outcome unknown.
 *   Its `status_code` tells a retry whether it went live (PUBLISHED) or can
 *   still be published, so a lost media_publish answer never posts twice.
 * - pending children: carousel items created, parent not yet.
 */
export const IG_PENDING_CONTAINER = 'ig:container';
export const IG_PENDING_CHILDREN = 'ig:children';

type Item = { kind: 'image' | 'video'; media: MediaAttachment };
type ContainerState =
	| { state: 'ready' }
	| { state: 'published' }
	| { state: 'processing' }
	| { state: 'failed'; status: string; detail: string }
	| null;

const isVideo = (m: MediaAttachment) => (m.mime || '').toLowerCase().startsWith('video/');

/** Instagram has no threads: like LinkedIn, a thread becomes one post. */
function singlePost(content: NormalizedPost): { text: string; media: MediaAttachment[] } {
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	return {
		text: joinThreadTexts(segments.map((s) => s.text)),
		media: segments.flatMap((s) => s.media ?? [])
	};
}

function mediaIssue(m: MediaAttachment): string | null {
	const mime = (m.mime || '').toLowerCase();
	if (isVideo(m)) {
		if (!VIDEO_MIMES.has(mime)) return 'Instagram videos must be MP4';
		if (mediaByteLength(m) > MAX_VIDEO_BYTES) return 'Instagram allows max 95MB per video';
		return null;
	}
	if (!IMAGE_MIMES.has(mime)) return 'Instagram images must be JPEG';
	if (mediaByteLength(m) > INSTAGRAM_MAX_IMAGE_BYTES) return 'Instagram allows max 8MB per image';
	return null;
}

function instagramUserId(creds: ConnectionCredentials, meta?: ConnectionMeta): string {
	const id = creds.instagramUserId || meta?.instagramUserId;
	if (id) return id;
	throw new ProviderError('Instagram credentials require the account id (reconnect account)', {
		code: 'auth'
	});
}

async function readContainer(
	id: string,
	token: string,
	fetchImpl: FetchLike
): Promise<ContainerState> {
	let res: Response;
	try {
		res = await fetchImpl(
			`${GRAPH}/${encodeURIComponent(id)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
		);
	} catch {
		return null;
	}
	if (!res.ok) {
		// A container id Meta no longer knows is as dead as an EXPIRED one.
		if (res.status >= 400 && res.status < 500 && res.status !== 429) {
			return { state: 'failed', status: 'MISSING', detail: (await res.text()).slice(0, 300) };
		}
		return null;
	}
	const data = (await res.json().catch(() => ({}))) as { status_code?: unknown; status?: unknown };
	switch (data.status_code) {
		case 'FINISHED':
			return { state: 'ready' };
		case 'PUBLISHED':
			return { state: 'published' };
		case 'IN_PROGRESS':
			return { state: 'processing' };
		case 'ERROR':
		case 'EXPIRED':
			return {
				state: 'failed',
				status: data.status_code,
				detail: typeof data.status === 'string' && data.status ? data.status : data.status_code
			};
		default:
			return null;
	}
}

export async function instagramPermalink(
	mediaId: string,
	token: string,
	fetchImpl: FetchLike
): Promise<string | null> {
	if (!mediaId) return null;
	try {
		const res = await fetchImpl(
			`${GRAPH}/${encodeURIComponent(mediaId)}?fields=permalink&access_token=${encodeURIComponent(token)}`
		);
		if (!res.ok) return null;
		const data = (await res.json()) as { permalink?: unknown };
		return httpUrl(data.permalink);
	} catch {
		// The post is live; a missing link must never fail it.
		return null;
	}
}

export const instagramProvider: PlatformProvider = {
	id: 'instagram',
	// Meta fetches every image and video from a signed URL.
	mediaByUrl: true,
	capabilities: {
		maxImages: INSTAGRAM_MAX_ITEMS,
		maxImageBytes: INSTAGRAM_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const { text, media } = singlePost(content);
		const check = validateInstagramText(text);
		if (!check.ok) {
			issues.push({ field: 'text', message: check.message || 'Text too long', code: 'max_length' });
		}
		if (media.length === 0) {
			issues.push({
				field: 'media',
				message: 'Instagram posts need an image or a video',
				code: 'media_required'
			});
		}
		if (media.length > INSTAGRAM_MAX_ITEMS) {
			issues.push({
				field: 'media',
				message: `Instagram allows max ${INSTAGRAM_MAX_ITEMS} images or videos per post`,
				code: 'max_images'
			});
		}
		for (const m of media) {
			const problem = mediaIssue(m);
			if (problem) issues.push({ field: 'media', message: problem, code: 'bad_media' });
		}
		return issues;
	},

	async publish(content, creds, meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken) {
			throw new ProviderError('Instagram credentials require accessToken (reconnect)', {
				code: 'auth'
			});
		}
		const token = creds.accessToken;
		const userId = instagramUserId(creds, meta);
		const resume = opts?.resume;
		const marker = resume?.segmentCids?.[0];
		const resumeIds = resume?.segmentIds ?? [];

		// An earlier attempt published and checkpointed the media id; the
		// failure came after (a lost database write), so there is nothing left.
		if (resumeIds.length && marker !== IG_PENDING_CONTAINER && marker !== IG_PENDING_CHILDREN) {
			return {
				remotePostId: resumeIds[0] || undefined,
				remoteUrl: resume?.remoteUrl ?? undefined,
				segmentIds: resumeIds
			};
		}

		const checkpoint = async (state: PublishCheckpoint) => {
			try {
				await opts?.checkpoint?.(state);
			} catch {
				// Best effort by contract.
			}
		};

		const { text, media } = singlePost(content);
		const items: Item[] = media
			.slice(0, INSTAGRAM_MAX_ITEMS)
			.map((m) => ({ kind: isVideo(m) ? 'video' : 'image', media: m }));
		if (!items.length) {
			throw new ProviderError('Instagram posts need an image or a video', { code: 'forbidden' });
		}
		for (const item of items) {
			const problem = mediaIssue(item.media);
			if (problem) throw new ProviderError(problem, { code: 'forbidden' });
		}

		async function createContainer(params: Record<string, string>): Promise<string> {
			const res = await fetchImpl(`${GRAPH}/${encodeURIComponent(userId)}/media`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ ...params, access_token: token })
			});
			if (!res.ok) throw metaUpstreamError('Instagram container', res.status, await res.text());
			const created = (await res.json().catch(() => ({}))) as { id?: unknown };
			if (typeof created.id !== 'string' && typeof created.id !== 'number') {
				throw new ProviderError('Instagram container returned no id', { code: 'upstream' });
			}
			return String(created.id);
		}

		async function mediaParams(item: Item, carouselItem: boolean): Promise<Record<string, string>> {
			if (!item.media.storageKey) throw new Error('Instagram media is missing its storage key');
			if (!opts?.mediaUrlFor) throw new Error('Instagram posts need a media signer');
			const url = await opts.mediaUrlFor(item.media.storageKey);
			const params: Record<string, string> =
				item.kind === 'video'
					? // A lone video is a Reel; standalone feed videos are no longer offered.
						{ media_type: carouselItem ? 'VIDEO' : 'REELS', video_url: url }
					: { image_url: url };
			if (carouselItem) params.is_carousel_item = 'true';
			const alt = item.media.alt?.trim();
			if (item.kind === 'image' && alt) params.alt_text = alt.slice(0, 1000);
			return params;
		}

		function containerFailure(state: { status: string; detail: string }): ProviderError {
			// EXPIRED (24h unused) and a vanished id are fixed by starting over;
			// ERROR is Meta refusing the media itself.
			const retryable = state.status !== 'ERROR';
			return new ProviderError(
				`Instagram media container ${state.status.toLowerCase()}: ${state.detail}`,
				{ code: retryable ? 'upstream' : 'forbidden', detail: state.detail }
			);
		}

		/** Waits for every carousel child, within the subrequest budget. */
		async function waitForChildren(
			ids: string[]
		): Promise<{ state: 'ready' | 'processing' } | { state: 'failed'; error: ProviderError }> {
			let calls = 0;
			for (;;) {
				const states: ContainerState[] = [];
				for (let i = 0; i < ids.length; i += STATUS_CONCURRENCY) {
					states.push(
						...(await Promise.all(
							ids.slice(i, i + STATUS_CONCURRENCY).map((id) => readContainer(id, token, fetchImpl))
						))
					);
				}
				calls += ids.length;
				const failed = states.find((s) => s?.state === 'failed');
				if (failed?.state === 'failed') return { state: 'failed', error: containerFailure(failed) };
				if (states.every((s) => s?.state === 'ready')) return { state: 'ready' };
				if (calls + ids.length > CHILD_CALL_BUDGET) return { state: 'processing' };
				await sleep(STATUS_POLL_MS);
			}
		}

		/** Polls until the container can be published; 'published' when it already was. */
		async function waitForContainer(id: string): Promise<'ready' | 'published' | 'processing'> {
			for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
				const state = await readContainer(id, token, fetchImpl);
				if (state?.state === 'ready') return 'ready';
				if (state?.state === 'published') return 'published';
				if (state?.state === 'failed') throw containerFailure(state);
				if (attempt + 1 < STATUS_ATTEMPTS) await sleep(STATUS_POLL_MS);
			}
			return 'processing';
		}

		const stillProcessing = () =>
			new ProviderError('Instagram is still processing the media — it will publish on retry', {
				code: 'upstream'
			});

		let containerId: string | null = null;
		if (marker === IG_PENDING_CONTAINER && resumeIds[0]) {
			// Reuse the container an earlier attempt left behind. Starting over
			// would risk a second post if that attempt's publish did land.
			const state = await readContainer(resumeIds[0], token, fetchImpl);
			if (state?.state === 'published') {
				await checkpoint({ segmentIds: [''], remoteUrl: null });
				return { segmentIds: [''] };
			}
			if (state?.state !== 'failed') containerId = resumeIds[0];
		}

		if (!containerId) {
			if (items.length === 1) {
				const params = await mediaParams(items[0], false);
				if (text) params.caption = text;
				containerId = await createContainer(params);
			} else {
				let children: string[] | null =
					marker === IG_PENDING_CHILDREN && resumeIds.length === items.length ? resumeIds : null;
				if (children) {
					const resumed = await waitForChildren(children);
					if (resumed.state === 'processing') throw stillProcessing();
					// A dead child poisons the parent; build a fresh set.
					if (resumed.state === 'failed') children = null;
				}
				if (!children) {
					children = [];
					for (const item of items)
						children.push(await createContainer(await mediaParams(item, true)));
					await checkpoint({
						segmentIds: children,
						segmentCids: [IG_PENDING_CHILDREN],
						remoteUrl: null
					});
					const fresh = await waitForChildren(children);
					if (fresh.state === 'failed') throw fresh.error;
					if (fresh.state === 'processing') throw stillProcessing();
				}
				const params: Record<string, string> = {
					media_type: 'CAROUSEL',
					children: children.join(',')
				};
				if (text) params.caption = text;
				containerId = await createContainer(params);
			}
			await checkpoint({
				segmentIds: [containerId],
				segmentCids: [IG_PENDING_CONTAINER],
				remoteUrl: null
			});
		}

		const ready = await waitForContainer(containerId);
		if (ready === 'published') {
			await checkpoint({ segmentIds: [''], remoteUrl: null });
			return { segmentIds: [''] };
		}
		if (ready === 'processing') throw stillProcessing();

		let res: Response;
		try {
			res = await fetchImpl(`${GRAPH}/${encodeURIComponent(userId)}/media_publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ creation_id: containerId, access_token: token })
			});
		} catch (err) {
			throw unconfirmedPostError('Instagram', err);
		}
		if (!res.ok) throw metaUpstreamError('Instagram publish', res.status, await res.text());
		const published = (await res.json().catch(() => ({}))) as { id?: unknown };
		const mediaId =
			typeof published.id === 'string' || typeof published.id === 'number'
				? String(published.id)
				: '';
		await checkpoint({ segmentIds: [mediaId], remoteUrl: null });
		const remoteUrl = await instagramPermalink(mediaId, token, fetchImpl);
		return {
			remotePostId: mediaId || undefined,
			remoteUrl: remoteUrl ?? undefined,
			segmentIds: [mediaId]
		};
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.accessToken) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		let res: Response;
		try {
			res = await fetchImpl(
				`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(creds.accessToken)}`
			);
		} catch {
			return creds;
		}
		if (!res.ok) {
			// Instagram only refreshes a live token that is at least a day old.
			// A refusal while the stored expiry is still ahead is that rule (or a
			// hiccup), not a dead credential: publish with what we have.
			if (creds.expiresAt && creds.expiresAt > Date.now()) return creds;
			if (res.status >= 400 && res.status < 500 && res.status !== 429) {
				throw new ProviderError(`Instagram token refresh rejected (${res.status}) — reconnect`, {
					status: 401,
					code: 'auth'
				});
			}
			return creds;
		}
		const data = (await res.json().catch(() => ({}))) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!data.access_token) return creds;
		return {
			...creds,
			accessToken: data.access_token,
			expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt
		};
	},

	refreshImpossibleReason(creds) {
		if (!creds.accessToken) return 'Instagram account has no token — reconnect it';
		// A long-lived token past its expiry cannot be refreshed any more.
		if (creds.expiresAt && creds.expiresAt < Date.now()) {
			return 'Instagram access expired after 60 days without a refresh — reconnect it';
		}
		return null;
	}
};

export function instagramAuthorizeUrl(appId: string, appUrl: string, state: string): string {
	const params = new URLSearchParams({
		client_id: appId,
		redirect_uri: `${appUrl.replace(/\/$/, '')}/api/connections/instagram/callback`,
		response_type: 'code',
		scope: INSTAGRAM_SCOPES.join(','),
		state
	});
	return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

type InstagramProfile = {
	userId?: string;
	username?: string;
	name?: string;
	avatarUrl?: string;
	accountType?: string;
};

// `user_id` is the professional account id that publishing takes; `id` is
// app-scoped and refused by the media endpoints.
const PROFILE_FIELDS = 'user_id,username,name,profile_picture_url,account_type';

async function fetchProfile(token: string, fetchImpl: FetchLike): Promise<InstagramProfile | null> {
	const res = await fetchImpl(
		`${GRAPH}/me?fields=${PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`
	);
	if (!res.ok) throw metaUpstreamError('Instagram profile', res.status, await res.text());
	const me = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	const str = (v: unknown) =>
		typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
	return {
		userId: str(me.user_id),
		username: str(me.username),
		name: str(me.name),
		avatarUrl: str(me.profile_picture_url),
		accountType: str(me.account_type)
	};
}

export async function instagramExchangeCode(
	args: { appId: string; appSecret: string; code: string; appUrl: string },
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	const tokRes = await fetchImpl('https://api.instagram.com/oauth/access_token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: args.appId,
			client_secret: args.appSecret,
			grant_type: 'authorization_code',
			redirect_uri: `${args.appUrl.replace(/\/$/, '')}/api/connections/instagram/callback`,
			// Instagram appends `#_` to the redirect, and some browsers keep it.
			code: args.code.replace(/#_$/, '')
		})
	});
	if (!tokRes.ok) {
		throw metaUpstreamError('Instagram token exchange', tokRes.status, await tokRes.text());
	}
	// Documented as wrapped in `data[]`; older apps still get the bare object.
	const raw = (await tokRes.json().catch(() => ({}))) as {
		data?: Array<{ access_token?: string; user_id?: string | number; permissions?: string }>;
		access_token?: string;
		user_id?: string | number;
		permissions?: string | string[];
	};
	const tok = raw.data?.[0] ?? raw;
	if (!tok.access_token) throw new Error('Instagram exchange returned no access_token');
	const granted = Array.isArray(tok.permissions)
		? tok.permissions
		: (tok.permissions ?? '').split(',').filter(Boolean);
	if (granted.length && !granted.includes('instagram_business_content_publish')) {
		throw new Error('Instagram did not grant publishing — allow it when you connect');
	}

	const longRes = await fetchImpl(
		`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(args.appSecret)}&access_token=${encodeURIComponent(tok.access_token)}`
	);
	if (!longRes.ok) {
		throw metaUpstreamError('Instagram long-lived exchange', longRes.status, await longRes.text());
	}
	const long = (await longRes.json().catch(() => ({}))) as {
		access_token?: string;
		expires_in?: number;
	};
	if (!long.access_token) throw new Error('Instagram long-lived exchange returned no token');

	const profile = await fetchProfile(long.access_token, fetchImpl);
	const userId = profile?.userId || (tok.user_id != null ? String(tok.user_id) : '');
	if (!userId) throw new Error('Instagram did not return the account id');
	const username = profile?.username;
	return {
		accessToken: long.access_token,
		expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : undefined,
		tokenType: 'bearer',
		scopes: granted.length ? granted : INSTAGRAM_SCOPES,
		clientId: args.appId,
		instagramUserId: userId,
		instagramUsername: username,
		handle: username ? `@${username}` : undefined,
		displayName: profile?.name || username || 'Instagram',
		avatarUrl: profile?.avatarUrl,
		maxCharacters: INSTAGRAM_MAX_CHARS
	};
}

export async function instagramVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{ displayName?: string; avatarUrl?: string; handle?: string; userId?: string }> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const profile = await fetchProfile(creds.accessToken, fetchImpl);
	return {
		displayName: profile?.name || profile?.username,
		avatarUrl: profile?.avatarUrl,
		handle: profile?.username ? `@${profile.username}` : undefined,
		userId: profile?.userId
	};
}
