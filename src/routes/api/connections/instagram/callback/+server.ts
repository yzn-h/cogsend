import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { INSTAGRAM_MAX_CHARS, instagramExchangeCode } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'instagram',
	pendingMarker: 'instagram',
	accountIdKey: 'instagramUserId',
	async complete({ pending, code, env }) {
		const appSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await instagramExchangeCode({
			appId: pending.clientId,
			appSecret,
			code,
			appUrl: env.APP_URL
		});
		return {
			// The app secret stays out of the row, as for Threads: refreshing a
			// long-lived Instagram token needs only the token itself.
			credentials: {
				accessToken: exchanged.accessToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				instagramUserId: exchanged.instagramUserId,
				instagramUsername: exchanged.instagramUsername
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: { instagramUserId: exchanged.instagramUserId, maxCharacters: INSTAGRAM_MAX_CHARS }
		};
	}
});
