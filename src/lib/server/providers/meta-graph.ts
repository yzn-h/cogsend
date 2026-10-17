import { formatThreadsMetaMarker, THREADS_META_AUTH_CODES } from '#lib/domain/threads-error.js';
import { ProviderError } from './types';

/**
 * Shared by the Instagram and Facebook providers. Threads keeps its own copy
 * because it talks to graph.threads.net, which versions separately.
 *
 * Graph API versions live for about two years; bump this when Meta announces
 * the end of this one.
 */
export const META_GRAPH_VERSION = 'v25.0';

export function parseMetaError(body: string): { code?: number; subcode?: number } {
	try {
		const err = (JSON.parse(body) as { error?: { code?: unknown; error_subcode?: unknown } })
			?.error;
		if (err && typeof err === 'object') {
			return {
				...(typeof err.code === 'number' ? { code: err.code } : {}),
				...(typeof err.error_subcode === 'number' ? { subcode: err.error_subcode } : {})
			};
		}
	} catch {
		// Not JSON: classified by HTTP status alone.
	}
	return {};
}

// Codes from Meta's Graph error reference. The HTTP status alone misleads:
// almost everything arrives as 400, including rate limits and outages.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
// 1/2: unknown or temporary service error. 9007: the container is not ready
// to publish yet, which waiting fixes.
const TRANSIENT_CODES = new Set([1, 2, 9007]);
// Instagram reports a media fetch it could not complete with these subcodes;
// the same URL usually works moments later.
const MEDIA_FETCH_SUBCODES = new Set([2207003, 2207020, 2207052]);

/**
 * A Graph API failure, always classified so publish.ts never falls back to
 * message matching: the "missing permissions" boilerplate Meta puts in
 * invalid-parameter errors would otherwise expire a healthy connection. The
 * ` [meta code.subcode]` marker is the one Threads uses, so the shared
 * human-error matchers read it the same way.
 */
export function metaUpstreamError(prefix: string, status: number, body: string): ProviderError {
	const { code, subcode } = parseMetaError(body);
	const marker = code !== undefined ? formatThreadsMetaMarker(code, subcode) : '';
	const message = `${prefix} failed (${status}): ${body.slice(0, 300)}${marker}`;
	const detail = body ? body.slice(0, 2000) : undefined;
	const opts = (c: ConstructorParameters<typeof ProviderError>[1]) => ({ status, detail, ...c });
	if (status === 401 || (code !== undefined && THREADS_META_AUTH_CODES.includes(code))) {
		return new ProviderError(message, opts({ code: 'auth' }));
	}
	if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
		return new ProviderError(message, opts({ code: 'rate_limited' }));
	}
	if (
		status >= 500 ||
		(code !== undefined && TRANSIENT_CODES.has(code)) ||
		(subcode !== undefined && MEDIA_FETCH_SUBCODES.has(subcode))
	) {
		return new ProviderError(message, opts({ code: 'upstream' }));
	}
	// Any other refusal is about this content or this account's permissions:
	// the identical request cannot succeed later, and the credential works.
	return new ProviderError(message, opts({ code: 'forbidden' }));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Only an http(s) URL Meta handed back is worth storing as a post link. */
export function httpUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
	} catch {
		return null;
	}
}
