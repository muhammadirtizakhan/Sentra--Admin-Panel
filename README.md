# SENTRA — admin

This is a Next.js Pages Router application. Existing UI markup and browser scripts are preserved; Express route modules run inside Next.js API Routes. There is no separate Express listener and no iframe. This is a compatibility migration, not a component-by-component React rewrite.

## Local startup

1. Run `npm install` in this folder.
2. Copy `.env.example` to `.env.local`, then fill your existing values.
3. Run `npm run dev`.
4. For a production build locally: `npm run build`, then `npm start`.

Open http://localhost:3002 (also /admin). PUBLIC_ORIGIN is this admin origin. DASHBOARD_ORIGIN must point to http://localhost:3001 for invitation registration links. Set your existing admin and Brevo settings here; dashboard does not need admin credentials or the email API key.

Existing invitation/device/user/recording views and approval email behavior are preserved. Public invitation requests are handled by the dashboard's own API. There is no cross-origin browser API dependency between the apps.

## Scope

Python source and database schema are unchanged. sql/ contains reference copies of the existing migrations; do not rerun or reset the database merely because of this migration. Vercel configuration, hosted worker scheduling and production media-streaming constraints are deferred as requested.
