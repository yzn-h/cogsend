import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { FACEBOOK_MAX_CHARS, facebookExchangeCode } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'facebook',
	pendingMarker: 'facebook',
	accountIdKey: 'facebookPageId',
	async complete({ pending, code, env }) {
		const appSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const pages = await facebookExchangeCode({
			appId: pending.clientId,
			appSecret,
			code,
			appUrl: env.APP_URL
		});
		return pages.map((page) => ({
			credentials: {
				accessToken: page.accessToken,
				tokenType: 'bearer',
				scopes: page.scopes,
				clientId: page.clientId,
				facebookPageId: page.facebookPageId
			},
			displayName: page.displayName,
			// Pages without a vanity username still need a distinct handle, or
			// two of them would collapse into one row on the handle fallback.
			handle: page.handle ?? page.facebookPageId,
			avatarUrl: page.avatarUrl,
			meta: { facebookPageId: page.facebookPageId, maxCharacters: FACEBOOK_MAX_CHARS }
		}));
	}
});
