import type { PageServerLoad } from './$types';
import { oauthPlatformRecord } from '#lib/domain/platform-setup.js';
import { listConnections } from '#lib/server/connection-list.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	try {
		return {
			...(await listConnections(locals.db, locals.env, user.id)),
			loadFailed: false
		};
	} catch (err) {
		// A transient D1 error must not turn the page into a 500: the client
		// keeps its retry path, which this flag arms.
		console.error('[accounts] list failed', err);
		return {
			connections: [],
			configured: oauthPlatformRecord(false),
			secrets: {},
			sources: oauthPlatformRecord(null),
			savedClientIds: oauthPlatformRecord(null),
			appUrl: locals.env.APP_URL,
			loadFailed: true
		};
	}
};
