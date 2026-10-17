import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { decryptJson, encryptSecret } from '#lib/server/crypto.js';
import { newId, parseJson, type AppDb } from '#lib/server/db/client.js';
import { connections, oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import type { ConnectionCredentials } from '#lib/server/providers/types.js';
import { GET as facebookCallback } from '../src/routes/api/connections/facebook/callback/+server';
import { GET as instagramCallback } from '../src/routes/api/connections/instagram/callback/+server';

async function redirected(call: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await call();
	} catch (e) {
		const err = e as { status?: number; location?: string };
		if (typeof err?.status === 'number')
			return { status: err.status, location: String(err.location ?? '') };
		throw e;
	}
	throw new Error('expected a redirect');
}

describe('meta oauth callbacks', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'oauth-meta@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	async function callbackUrl(platform: 'facebook' | 'instagram') {
		const pendingId = newId();
		await db.insert(oauthPending).values({
			id: pendingId,
			userId,
			instanceUrl: platform,
			clientId: `${platform}-app`,
			clientSecretEnc: await encryptSecret(`${platform}-secret`, TEST_ENV.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + 10 * 60_000),
			createdAt: new Date()
		});
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-meta'
		});
		return new URL(
			`http://localhost/api/connections/${platform}/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
	}

	const event = (url: URL) =>
		({ url, locals: { db, env: TEST_ENV }, cookies: { get: () => 'sess-meta' } }) as never;

	function pagesFetch(pages: Array<{ id: string; name: string }>) {
		return vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.includes('fb_exchange_token=')) return Response.json({ access_token: 'long-user' });
			if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'short-user' });
			if (url.includes('/me/accounts')) {
				return Response.json({
					data: pages.map((p) => ({
						...p,
						access_token: `token-${p.id}`,
						tasks: ['CREATE_CONTENT']
					}))
				});
			}
			return new Response('unmocked', { status: 404 });
		});
	}

	const facebookRows = () =>
		db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, 'facebook')));

	it('stores one connection per Facebook Page, each with its own Page token', async () => {
		vi.stubGlobal(
			'fetch',
			pagesFetch([
				{ id: '42', name: 'Example Studio' },
				{ id: '43', name: 'Side Project' }
			])
		);
		const out = await redirected(async () =>
			facebookCallback(event(await callbackUrl('facebook')))
		);
		expect(out.location).toContain('connected=facebook');
		const rows = await facebookRows();
		expect(rows.map((r) => r.displayName).sort()).toEqual(['Example Studio', 'Side Project']);
		for (const row of rows) {
			const creds = await decryptJson<ConnectionCredentials>(
				row.credentialsEncrypted,
				TEST_ENV.APP_ENCRYPTION_KEY
			);
			expect(creds.accessToken).toBe(`token-${creds.facebookPageId}`);
			expect(parseJson<{ facebookPageId?: string }>(row.metaJson, {}).facebookPageId).toBe(
				creds.facebookPageId
			);
		}
	});

	it('updates Pages it already has and adds new ones when connected again', async () => {
		vi.stubGlobal(
			'fetch',
			pagesFetch([
				{ id: '42', name: 'Example Studio (renamed)' },
				{ id: '44', name: 'Jam Entry' }
			])
		);
		await redirected(async () => facebookCallback(event(await callbackUrl('facebook'))));
		const rows = await facebookRows();
		expect(rows.map((r) => r.displayName).sort()).toEqual([
			'Example Studio (renamed)',
			'Jam Entry',
			'Side Project'
		]);
	});

	it('connects an Instagram professional account by its account id', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.includes('api.instagram.com/oauth/access_token')) {
					return Response.json({
						data: [
							{
								access_token: 'short',
								user_id: 'x',
								permissions: 'instagram_business_basic,instagram_business_content_publish'
							}
						]
					});
				}
				if (url.includes('graph.instagram.com/access_token')) {
					return Response.json({ access_token: 'long', expires_in: 5_183_944 });
				}
				if (url.includes('/me?fields=')) {
					return Response.json({ user_id: '1784', username: 'example.studio', name: 'Example' });
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		const out = await redirected(async () =>
			instagramCallback(event(await callbackUrl('instagram')))
		);
		expect(out.location).toContain('connected=instagram');
		const [row] = await db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, 'instagram')));
		expect(row.handle).toBe('@example.studio');
		const creds = await decryptJson<ConnectionCredentials>(
			row.credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds).toMatchObject({ accessToken: 'long', instagramUserId: '1784' });
		// The app secret never lands on the row.
		expect(JSON.stringify(creds)).not.toContain('instagram-secret');
	});
});
