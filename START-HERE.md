# SENTRA dashboard and admin deployment

This ZIP contains TWO COMPLETE source projects with the Reset, Delete invitation and styled confirmation changes merged. It does not include Python or the Windows installer. Keep your old project/configuration backups.

## What you deploy
Create two separate Vercel projects/repos, or choose the corresponding Root Directory in one repository:
- dashboard/ — customer website, accounts, history, video playback, push subscriptions and secured scheduler endpoint.
- admin/ — company admin, invitations, user and recording directory.
Framework: Next.js. Build command: npm run build. Install: npm ci. Output: framework default (do NOT set public or out). Do not run the standalone push-worker.js as a Vercel start command.

Each folder has .env.example listing its EXACT server ENV variable names. Copy values from your existing working setup into Vercel > Settings > Environment Variables. Never upload .env or secrets into Git. Add variables to Production; if testing Preview, configure its origins/variables appropriately too.

## 1. Preserve your working database and keys
Use the SAME Supabase project and existing account/push/ownership migrations. Do not reset tables.
If not already applied, run admin/sql/010_delete_invitation_request.sql AFTER migration 007 in that Supabase SQL Editor. It installs the delete RPC only; it does not delete anything at installation.
Keep the SAME VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY used for existing push subscriptions. Generating a new pair breaks those subscriptions until re-enabled.
SUPABASE_KEY is the EXISTING server service-role key, not the public anon key. Never prefix it NEXT_PUBLIC_.

## 2. Drive: these are existing OAuth values, not new paid API keys
The newly authorized Python secrets/google-drive-token.json has fields:
- client_id -> GOOGLE_DRIVE_CLIENT_ID
- client_secret -> GOOGLE_DRIVE_CLIENT_SECRET
- refresh_token -> GOOGLE_DRIVE_REFRESH_TOKEN
They must authorize the same Google account/application that uploaded the private recordings. A folder ID is not an access credential. Keep Drive files private.

On YOUR laptop in the dashboard project folder run:

    node tools/prepare-drive-env.cjs "C:\FULL\PATH\TO\PYTHON\secrets\google-drive-token.json"

Use the REAL token file found earlier, not this placeholder. The helper saves .private/drive-vercel.env locally. Open it yourself and add its three names/values separately in Vercel's DASHBOARD Environment Variables. Do not send this file to anyone. No values are printed by the helper. Do not upload .private/.
Remove GOOGLE_DRIVE_TOKEN_FILE from Vercel. It is a laptop filesystem path. All-three-ENV mode now skips file reading entirely, even if an obsolete path is still present.
The ADMIN project does not need Drive credentials in this version.
If Google later revokes/expires the authorization, renew locally and update the dashboard refresh-token value; this ZIP cannot prevent Google-side revocation.

## 3. First deployment and origins
Deploy both projects to obtain their stable production URLs, then set:
- Dashboard PUBLIC_ORIGIN=https://YOUR-DASHBOARD-PROJECT.vercel.app
- Admin PUBLIC_ORIGIN=https://YOUR-ADMIN-PROJECT.vercel.app
- Admin DASHBOARD_ORIGIN=https://YOUR-DASHBOARD-PROJECT.vercel.app
Use EXACT origins, with https and no trailing slash/path. Admin DASHBOARD_ORIGIN determines registration links in invitation emails. PUBLIC_ORIGIN protects POST requests; a mismatched origin causes 403.
Redeploy both after ENV changes.

## 4. Background push: no browser or laptop worker required once scheduler is configured
The deployed dashboard has:

    GET https://YOUR-DASHBOARD-PROJECT.vercel.app/api/internal/push
    Authorization: Bearer YOUR_CRON_SECRET_VALUE

POST with the same header is also accepted. No user cookie is needed; the secret is mandatory. Missing/wrong secret returns 401; incomplete service configuration returns 503. Never put the secret in a URL query.

Create the secret locally once:

    node tools/generate-cron-secret.cjs

Open .private/cron-secret.env yourself. Set CRON_SECRET to that value in Vercel DASHBOARD and redeploy. Re-running the helper preserves its existing generated file.

Set an EXTERNAL HTTP scheduler (for example the cron service you already use) to call that URL EVERY MINUTE:
- Method: GET
- Header name: Authorization
- Header value: Bearer <the same CRON_SECRET value>
- Do not include CRON_SECRET= in the header value.
- Use production URL, not Preview URL. Endpoint must be reachable without Vercel login/deployment-protection wall.
- No request body needed. Enable the schedule, run a manual test, expect HTTP 200 with ok:true.

Vercel Hobby's built-in cron runs at most daily; no minute cron is installed in vercel.json, avoiding a Hobby deployment rejection. An external scheduler setup still has to be performed in YOUR scheduler account using YOUR deployed URL and secret; it is not created by uploading this ZIP.

The handler processes up to FOUR queued jobs per invocation, in parallel. Database leases coordinate competing executions. Bigger queues need more frequent supported scheduling or the existing always-on worker on suitable hosting. At one-minute scheduling, delivery includes scheduler delay (roughly a minute plus processing/network under light load), not instant guaranteed delivery. A 200 response confirms the queue check, not that every device displayed a notification.

Test notifications are sent immediately by /api/push/test; real-alert notifications depend on the queue/scheduler. Do not mistake a successful Send test for a successful real-alert background test.
You may keep the old standalone worker running during transition; database claiming prevents normal double claims. The scheduler path needs no RUN_PUSH_WORKER=true flag.

## 5. Existing settings per project
DASHBOARD:
- SUPABASE_URL, SUPABASE_KEY: existing database credentials
- PUBLIC_ORIGIN: this dashboard's deployed URL
- SUPABASE_BUCKET: evidence
- VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: existing push values
- CRON_SECRET: newly generated scheduler secret
- Three GOOGLE_DRIVE_* OAuth values above
- Optional SENTRA_COMPANY_NAME, SENTRA_TEAM_MEMBERS, APP_TZ

ADMIN:
- SUPABASE_URL, SUPABASE_KEY: same database
- PUBLIC_ORIGIN: admin deployed URL
- DASHBOARD_ORIGIN: dashboard deployed URL
- ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), ADMIN_SESSION_SECRET (32+ characters): existing admin settings
- BREVO_API_KEY: active account's API key
- BREVO_SENDER_EMAIL: sender verified IN THAT account
- BREVO_SENDER_NAME: Nexora Solvex
- Optional SENTRA_COMPANY_NAME, APP_TZ
No Python installation path or PORT value is needed in Vercel.

## 6. Acceptance test before APK/installer
1. Open admin, sign in, approve one requested invitation. Verify delivered email points to production dashboard /register.
2. Register/sign in dashboard. Confirm own recordings only. Test video playback and seeking with a real recording. Proxy streams and large detection files still depend on function duration/provider limits; long recordings require real deployed playback testing.
3. Android CHROME: HTTPS dashboard -> log in -> enable notifications -> Send test. Allow Android/browser notifications.
4. In your scheduler manually invoke endpoint with Authorization header; verify 200.
5. Close dashboard tab/lock phone, generate NEW real alert from Python, keep Python/internet running. Wait for scheduled delivery. Check the job database/server logs if it fails.
6. Test Reset stays cleared after >60 seconds and reload; History loads analysis again. Notifications remain enabled after Reset.
7. Delete a test invitation: unused codes stop working; registered accounts stay intact.
8. Only after Chrome/PWA push works, test any APK separately. Basic WebView wrappers do not automatically inherit browser push support.

## Validation and limits
Dashboard production build and focused deployment/reset/admin/dialog checks are recorded in VALIDATION.txt. No real credentials or live database/email/Drive/push sends were used in validation.
Neither the external scheduler, Vercel project ENV, nor production deployment is configured until you perform the account steps above.
This package does not implement the Python client/server credential separation or Windows installer. Company cloud secrets must not be bundled into a client installer.
