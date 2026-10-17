import { joinThreadTexts } from '#lib/domain/thread-segments.js';
import { FACEBOOK_MAX_CHARS, validateFacebookText } from '#lib/domain/validation/text.js';
import {
	FACEBOOK_MAX_IMAGE_BYTES,
	FACEBOOK_MAX_IMAGES,
	MAX_VIDEO_BYTES
} from '#lib/domain/media-limits.js';
import { httpUrl, META_GRAPH_VERSION, metaUpstreamError } from './meta-graph';
import { mediaByteLength, ProviderError, unconfirmedPostError } from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import { providerFetch } from './timed-fetch';

export { FACEBOOK_MAX_CHARS };
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${META_GRAPH_VERSION}`;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const VIDEO_MIMES = new Set(['video/mp4']);

const isVideo = (m: MediaAttachment) => (m.mime || '').toLowerCase().startsWith('video/');

/** Pages have no threads: like LinkedIn, a thread becomes one post. */
function singlePost(content: NormalizedPost): { text: string; media: MediaAttachment[] } {
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	return {
		text: joinThreadTexts(segments.map((s) => s.text)),
		media: segments.flatMap((s) => s.media ?? [])
	};
}

function mediaProblems(media: MediaAttachment[]): string[] {
	const problems: string[] = [];
	const videos = media.filter(isVideo);
	if (videos.length > 1) problems.push('Facebook allows one video per post');
	if (videos.length && videos.length < media.length) {
		problems.push('Facebook video posts cannot include images');
	}
	if (media.length - videos.length > FACEBOOK_MAX_IMAGES) {
		problems.push(`Facebook allows max ${FACEBOOK_MAX_IMAGES} photos per post`);
	}
	for (const m of media) {
		const mime = (m.mime || '').toLowerCase();
		if (isVideo(m)) {
			if (!VIDEO_MIMES.has(mime)) problems.push('Facebook videos must be MP4');
			else if (mediaByteLength(m) > MAX_VIDEO_BYTES)
				problems.push('Facebook allows max 95MB per video');
		} else if (!IMAGE_MIMES.has(mime)) {
			problems.push('Facebook photos must be JPEG, PNG or GIF');
		} else if (mediaByteLength(m) > FACEBOOK_MAX_IMAGE_BYTES) {
			problems.push('Facebook allows max 4MB per photo');
		}
	}
	return [...new Set(problems)];
}

function pageId(creds: ConnectionCredentials, meta?: ConnectionMeta): string {
	const id = creds.facebookPageId || meta?.facebookPageId;
	if (id) return id;
	throw new ProviderError('Facebook credentials require the Page id (reconnect account)', {
		code: 'auth'
	});
}

/**
 * Best-effort public link. `permalink_url` is absolute for posts and
 * site-relative for videos; a post id (`{page}_{post}`) also resolves on
 * facebook.com directly, which is the fallback when the lookup fails.
 */
export async function facebookPermalink(
	objectId: string,
	token: string,
	fetchImpl: FetchLike
): Promise<string | null> {
	if (!objectId) return null;
	const fallback = `https://www.facebook.com/${encodeURIComponent(objectId)}`;
	try {
		const res = await fetchImpl(
			`${GRAPH}/${encodeURIComponent(objectId)}?fields=permalink_url&access_token=${encodeURIComponent(token)}`
		);
		if (!res.ok) return fallback;
		const data = (await res.json()) as { permalink_url?: unknown };
		if (typeof data.permalink_url === 'string' && data.permalink_url.startsWith('/')) {
			return `https://www.facebook.com${data.permalink_url}`;
		}
		return httpUrl(data.permalink_url) ?? fallback;
	} catch {
		return fallback;
	}
}

export const facebookProvider: PlatformProvider = {
	id: 'facebook',
	// Photos and videos are fetched by Meta from signed URLs.
	mediaByUrl: true,
	capabilities: {
		maxImages: FACEBOOK_MAX_IMAGES,
		maxImageBytes: FACEBOOK_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const { text, media } = singlePost(content);
		if (!text && media.length === 0) {
			issues.push({ field: 'text', message: 'Post needs text or media', code: 'empty' });
		}
		const check = validateFacebookText(text);
		if (!check.ok) {
			issues.push({ field: 'text', message: check.message || 'Text too long', code: 'max_length' });
		}
		for (const message of mediaProblems(media)) {
			issues.push({ field: 'media', message, code: 'bad_media' });
		}
		return issues;
	},

	async publish(content, creds, meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken) {
			throw new ProviderError('Facebook credentials require accessToken (reconnect)', {
				code: 'auth'
			});
		}
		const token = creds.accessToken;
		const page = pageId(creds, meta);
		const resumeIds = opts?.resume?.segmentIds ?? [];
		// One post per target: a checkpointed id means it is already live.
		if (resumeIds.length) {
			return {
				remotePostId: resumeIds[0] || undefined,
				remoteUrl: opts?.resume?.remoteUrl ?? undefined,
				segmentIds: resumeIds
			};
		}

		const { text, media } = singlePost(content);
		const problems = mediaProblems(media);
		if (problems.length) throw new ProviderError(problems[0], { code: 'forbidden' });
		if (!text && !media.length) {
			throw new ProviderError('Post needs text or media', { code: 'forbidden' });
		}

		async function signedUrl(m: MediaAttachment): Promise<string> {
			if (!m.storageKey) throw new Error('Facebook media is missing its storage key');
			if (!opts?.mediaUrlFor) throw new Error('Facebook media posts need a media signer');
			return opts.mediaUrlFor(m.storageKey);
		}

		async function post(
			url: string,
			params: Record<string, string>,
			label: string,
			creates: boolean,
			multipart = false
		): Promise<Record<string, unknown>> {
			let body: URLSearchParams | FormData = new URLSearchParams({
				...params,
				access_token: token
			});
			if (multipart) {
				body = new FormData();
				for (const [key, value] of Object.entries({ ...params, access_token: token })) {
					body.append(key, value);
				}
			}
			let res: Response;
			try {
				// fetch sets the multipart boundary itself, so no Content-Type here.
				res = await fetchImpl(url, { method: 'POST', body });
			} catch (err) {
				// Only the request that makes the post visible can leave one behind.
				if (creates) throw unconfirmedPostError('Facebook', err);
				throw err;
			}
			if (!res.ok) throw metaUpstreamError(label, res.status, await res.text());
			return (await res.json().catch(() => ({}))) as Record<string, unknown>;
		}

		const idOf = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
		let postId: string;
		const video = media.find(isVideo);
		if (video) {
			const params: Record<string, string> = { file_url: await signedUrl(video) };
			if (text) params.description = text;
			// Meta downloads the file inside this request. Sent as multipart so
			// providerFetch gives it the upload budget rather than the 15s JSON
			// one, which a large video would outlast.
			const created = await post(
				`${GRAPH_VIDEO}/${encodeURIComponent(page)}/videos`,
				params,
				'Facebook video',
				true,
				true
			);
			postId = idOf(created.id);
		} else if (media.length === 1) {
			const params: Record<string, string> = { url: await signedUrl(media[0]) };
			if (text) params.caption = text;
			const alt = media[0].alt?.trim();
			if (alt) params.alt_text_custom = alt;
			const created = await post(
				`${GRAPH}/${encodeURIComponent(page)}/photos`,
				params,
				'Facebook photo',
				true
			);
			postId = idOf(created.post_id) || idOf(created.id);
		} else if (media.length > 1) {
			// Unpublished photos are invisible until the feed post attaches them,
			// so a retry that uploads them again leaves no duplicate behind.
			const photoIds: string[] = [];
			for (const m of media) {
				const params: Record<string, string> = { url: await signedUrl(m), published: 'false' };
				const alt = m.alt?.trim();
				if (alt) params.alt_text_custom = alt;
				const uploaded = await post(
					`${GRAPH}/${encodeURIComponent(page)}/photos`,
					params,
					'Facebook photo',
					false
				);
				const id = idOf(uploaded.id);
				if (!id)
					throw new ProviderError('Facebook photo upload returned no id', { code: 'upstream' });
				photoIds.push(id);
			}
			const params: Record<string, string> = {
				attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id })))
			};
			if (text) params.message = text;
			const created = await post(
				`${GRAPH}/${encodeURIComponent(page)}/feed`,
				params,
				'Facebook post',
				true
			);
			postId = idOf(created.id);
		} else {
			const created = await post(
				`${GRAPH}/${encodeURIComponent(page)}/feed`,
				{ message: text },
				'Facebook post',
				true
			);
			postId = idOf(created.id);
		}

		try {
			await opts?.checkpoint?.({ segmentIds: [postId], remoteUrl: null });
		} catch {
			// Best effort by contract.
		}
		const remoteUrl = await facebookPermalink(postId, token, fetchImpl);
		return {
			remotePostId: postId || undefined,
			remoteUrl: remoteUrl ?? undefined,
			segmentIds: [postId]
		};
	}
};

export function facebookAuthorizeUrl(appId: string, appUrl: string, state: string): string {
	const params = new URLSearchParams({
		client_id: appId,
		redirect_uri: `${appUrl.replace(/\/$/, '')}/api/connections/facebook/callback`,
		response_type: 'code',
		scope: FACEBOOK_SCOPES.join(','),
		state
	});
	return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

export type FacebookPage = {
	accessToken: string;
	facebookPageId: string;
	displayName: string;
	handle?: string;
	avatarUrl?: string;
	clientId: string;
	scopes: string[];
};

async function getJson(url: string, label: string, fetchImpl: FetchLike) {
	const res = await fetchImpl(url);
	if (!res.ok) throw metaUpstreamError(label, res.status, await res.text());
	return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Every Page the person picked in Facebook's dialog, each with its own token.
 * Page tokens issued from a long-lived user token carry no expiry, so these
 * connections never need a refresh; they die only when the person changes
 * their password, loses the Page role or removes the app.
 */
export async function facebookExchangeCode(
	args: { appId: string; appSecret: string; code: string; appUrl: string },
	fetchImpl: FetchLike = providerFetch
): Promise<FacebookPage[]> {
	const redirect = `${args.appUrl.replace(/\/$/, '')}/api/connections/facebook/callback`;
	const short = await getJson(
		`${GRAPH}/oauth/access_token?${new URLSearchParams({
			client_id: args.appId,
			client_secret: args.appSecret,
			redirect_uri: redirect,
			code: args.code.replace(/#_$/, '')
		})}`,
		'Facebook token exchange',
		fetchImpl
	);
	if (typeof short.access_token !== 'string') {
		throw new Error('Facebook exchange returned no access_token');
	}
	const long = await getJson(
		`${GRAPH}/oauth/access_token?${new URLSearchParams({
			grant_type: 'fb_exchange_token',
			client_id: args.appId,
			client_secret: args.appSecret,
			fb_exchange_token: short.access_token
		})}`,
		'Facebook long-lived exchange',
		fetchImpl
	);
	const userToken = typeof long.access_token === 'string' ? long.access_token : short.access_token;

	type PageRow = {
		id?: unknown;
		name?: unknown;
		username?: unknown;
		access_token?: unknown;
		tasks?: unknown;
		picture?: { data?: { url?: unknown } };
	};
	const pages: FacebookPage[] = [];
	let next: string | null =
		`${GRAPH}/me/accounts?fields=id,name,username,access_token,tasks,picture{url}&limit=100&access_token=${encodeURIComponent(userToken)}`;
	// A handful of pages is the norm; the cap only guards a runaway cursor.
	for (let page = 0; next && page < 5; page++) {
		const body = (await getJson(next, 'Facebook Pages', fetchImpl)) as {
			data?: PageRow[];
			paging?: { next?: unknown };
		};
		for (const row of body.data ?? []) {
			if (typeof row.access_token !== 'string' || !row.access_token) continue;
			const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
			if (!id) continue;
			// Without CREATE_CONTENT the Page token cannot post; listing the Page
			// would only produce failures later.
			const tasks = Array.isArray(row.tasks) ? row.tasks : null;
			if (tasks && !tasks.includes('CREATE_CONTENT')) continue;
			const username = typeof row.username === 'string' ? row.username : undefined;
			pages.push({
				accessToken: row.access_token,
				facebookPageId: id,
				displayName: typeof row.name === 'string' && row.name ? row.name : 'Facebook Page',
				handle: username ? `@${username}` : undefined,
				avatarUrl: httpUrl(row.picture?.data?.url) ?? undefined,
				clientId: args.appId,
				scopes: FACEBOOK_SCOPES
			});
		}
		next = typeof body.paging?.next === 'string' ? body.paging.next : null;
	}
	if (!pages.length) {
		throw new Error(
			'Facebook shared no Pages you can post to — choose at least one Page when you connect'
		);
	}
	return pages;
}

export async function facebookVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{ displayName?: string; avatarUrl?: string; handle?: string }> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const id = creds.facebookPageId;
	if (!id) throw new Error('Missing Facebook Page id');
	const page = (await getJson(
		`${GRAPH}/${encodeURIComponent(id)}?fields=id,name,username,picture{url}&access_token=${encodeURIComponent(creds.accessToken)}`,
		'Facebook verify',
		fetchImpl
	)) as { name?: unknown; username?: unknown; picture?: { data?: { url?: unknown } } };
	return {
		displayName: typeof page.name === 'string' ? page.name : undefined,
		avatarUrl: httpUrl(page.picture?.data?.url) ?? undefined,
		handle: typeof page.username === 'string' ? `@${page.username}` : undefined
	};
}
