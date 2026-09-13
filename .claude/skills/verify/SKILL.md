---
name: verify
description: Build, run and drive Realx8 (Realx8-Core API + Realx8-Ui web app) to observe a change at its real surface.
---

# Verifying Realx8

Two paired repos: `Realx8-Core` (nine services in one process) and
`Realx8-Ui` (Vite + React) next door at `../Realx8-Ui`.

## Running it

`npm run dev:all` from Realx8-Core starts core **and** the UI.
Core listens on **3000**, Vite on **5173**.

Boot is sequential and slow — roughly 30s for all nine services, with
property and crm the long poles. Until `finance: ready` appears you
will see `ECONNREFUSED` proxy errors in the Vite log for
`/transactions`, `/receipts`, `/taxes` and friends. **That is boot
ordering, not a fault.** Wait for health:

    curl -s http://localhost:3000/health

## The edge blocks curl — this is the main gotcha

`npm run security:config` shows the posture. By default:

- **automated tool detection** is on and strict: a browser-shaped
  `User-Agent` plus `Accept`, `Accept-Language` and `Accept-Encoding`
  are all required
- **frontend signature** is on and verifying: header `x-realx8-auth`,
  HMAC-SHA256 over `appId|timestamp|nonce|METHOD|path`

So plain `curl` gets a blanket **403 with no body** on every path,
including routes that do not exist — you cannot tell a missing route
from a blocked request that way.

Two ways through:

1. **Mimic the UI.** The key is `VITE_FRONTEND_SECRET` in
   `Realx8-Ui/.env` (it ships in the browser bundle by design — see
   `src/api/frontendSignature.js`). Sign as that file does, and send
   the browser headers above. Note the signed path drops the `/api`
   prefix and excludes the query string.
2. **Drive a real browser.** `playwright-core` plus the installed
   Chrome at `/Applications/Google Chrome.app/...` — no browser
   download needed. **Override the user agent**: headless Chrome
   announces itself as `HeadlessChrome` and the tool detector refuses
   it, which shows up as every page bouncing to `/login` with 403s in
   the console.

## Getting a session

Registration requires a company referral code:

    SELECT id, name, referral_code FROM companies;

then `POST /api/auth/register` with `{ name, email, password,
company_code }` and log in. The dev database is `realto` in the
`mysql-docker-container` container (root password in its container
env). A Postgres for `npm run verify:dialect` runs as `realx8-pg` on
5433.

Clean up anything you seed — the dev database is the user's working
data, not a fixture.

## New top-level routes need registering

`platform/registry.js` maps path prefixes to services. A route added
to a service's own router is **unreachable** until its prefix is listed
there, and the symptom is "no route found" with nothing in the service
log. `npm run routes` prints the resolved table.

## Worth driving

- client: `/finance/my-properties`, `/finance/my-invoices`,
  `/finance/my-payments`, `/finance/invoices/:id`
- admin: `/receipts` (payment approvals), invoice detail settlement panel
- `npm run verify:dialect` covers MySQL/Postgres divergence and needs
  both containers up. It is a test suite, not a substitute for running
  the app.
