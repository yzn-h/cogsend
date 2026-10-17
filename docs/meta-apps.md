# Meta apps for Instagram and Facebook

Instagram and Facebook Pages publish through an app you create in [Meta for Developers](https://developers.facebook.com/apps/). This page walks through creating it, connecting your own accounts while the app stays in **Development mode**, and what that mode does and does not allow. The short version of each platform's steps is in [OAuth apps](oauth-apps.md#instagram).

One Meta app can hold both use cases, or you can make one app per platform. Instagram and Facebook use different credentials either way, so CogSend asks for each separately.

## Create the app

1. In [Meta for Developers](https://developers.facebook.com/apps/), choose **Create app**. Sign in with the Facebook account that manages your Pages; it becomes the app's admin.
2. Pick the use cases: **Manage messaging & content on Instagram** for Instagram, **Manage everything on your Page** for Facebook. You can add the other one later from **Use cases**.
3. Attach a business portfolio if Meta asks for one. A new, empty portfolio is enough.
4. Under **App settings → Basic**, fill in a privacy policy URL and an app icon. Meta asks for them before some settings save, and they cost nothing.

## Instagram

Only **Business** and **Creator** accounts can publish through the API. Switch a personal account in the Instagram app under **Settings → Account type and tools → Switch to professional account**; this needs no Facebook Page.

1. Open **Use cases → Manage messaging & content on Instagram → Customize → API setup with Instagram login**.
2. Copy the **Instagram app ID** and **Instagram app secret** shown there. They are not the Meta app's own ID and secret, and the Meta ones fail at Instagram's authorise step.
3. Under **Set up Instagram business login → Business login settings**, add the redirect URI the accounts dialog shows (`{APP_URL}/api/connections/instagram/callback`) to **OAuth redirect URIs** and save.
4. Add the account you will connect as a tester: **App roles → Roles → Add people → Instagram Tester**, enter its username, then accept the invite in Instagram under **Settings → Website permissions → Apps and websites → Tester invites** (or at instagram.com/accounts/manage_access).
5. Give CogSend the credentials, in the accounts dialog or with:

   ```sh
   npm run secrets:put INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET
   ```

6. In CogSend, **Connect new → Instagram**, sign in as the tester account and allow both permissions.

The token Instagram issues lasts 60 days, and CogSend renews it whenever it is within a week of expiring and something publishes or you press **Verify**. An account that publishes nothing for two months has to be reconnected.

What publishes: one JPEG becomes a photo post, one MP4 becomes a Reel, and two to ten items become a carousel, which may mix photos and videos. Instagram accepts JPEG only, so convert PNG and WebP first. Captions take up to 2,200 characters and 30 hashtags. Instagram allows 100 API posts per account in 24 hours.

## Facebook

1. Open **Use cases → Manage everything on your Page → Customize** and make sure `pages_show_list`, `pages_read_engagement` and `pages_manage_posts` are listed (add any that are missing).
2. In that use case's Facebook Login **Settings**, add the redirect URI the accounts dialog shows (`{APP_URL}/api/connections/facebook/callback`) to **Valid OAuth Redirect URIs** and save.
3. Copy the **App ID** and **App secret** from **App settings → Basic**.
4. Everyone who will connect needs a role on the app (**App roles → Roles**: Administrator, Developer or Tester) and must be able to create content on the Page.
5. Give CogSend the credentials, in the accounts dialog or with:

   ```sh
   npm run secrets:put FACEBOOK_APP_ID FACEBOOK_APP_SECRET
   ```

6. In CogSend, **Connect new → Facebook** and tick every Page you want in Facebook's dialog. Each one becomes its own account. Connect again to add Pages later.

Page tokens do not expire on a timer. They stop working when the person who connected changes their Facebook password, loses their role on the Page or removes the app, and the account then shows as needing a reconnect.

What publishes: text, text with up to ten photos (JPEG, PNG or GIF, 4MB each), or text with one MP4 video. Links in the text get Facebook's own preview.

## Development mode

A new Meta app starts in Development mode. In that mode the app works for the people who have a role on it, with every permission at standard access and no App Review, which is exactly what a studio posting to its own accounts needs to connect and publish. Two limits apply:

- **Only role holders can connect.** Add each person as an app admin, developer or tester, and each Instagram account as an Instagram tester. Anyone else sees an error at Meta's sign-in page.
- **Facebook shows Development-mode content only to role holders.** Meta's documentation says data an app creates while in Development mode, test posts included, is visible only to people with a role on the app until the app switches to Live. Page posts published this way are therefore not public. Check the first one from a logged-out browser before you rely on it.

To make Facebook posts public, switch the app to **Live** with the toggle at the top of the App Dashboard. Meta's guidance is to go Live after App Review, and a Live app may only use the permissions Review approved, so expect to submit `pages_manage_posts` (with a screencast of the connect and publish flow) if the toggle or the posts are refused.

Instagram documents no equivalent visibility limit for content published through the Instagram API, but check the first post from a logged-out browser in the same way.

## When it goes wrong

- **"Invalid redirect_uri" or "URL blocked"** — the redirect URI in the Meta dashboard does not match this instance's exactly. Copy it again from the accounts dialog; see [Domains and URLs](domains.md) after a hostname change.
- **"Insufficient developer role"** or a blank Instagram consent screen — the account is not a tester yet, or the invite was not accepted.
- **"Instagram images must be JPEG"** — convert the image; Instagram's publishing API refuses everything else.
- **"Instagram is still processing the media"** — normal for a long Reel. The post stays scheduled and the next tick publishes the same upload once Instagram has finished.
- **"Facebook shared no Pages you can post to"** — no Page was ticked in Facebook's dialog, or your role on the ticked Pages cannot create content.
