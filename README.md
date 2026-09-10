# Realx8-Core

The Realx8 backend: nine services, **one thing to deploy**, splittable per service
when you need it.

Paired with [`Realx8-Ui`](../Realx8-Ui) (the web app), which is deployed
separately and talks to this over a single base URL.

```bash
cp cred.env.example cred.env     # fill in DB + JWT_SECRET
npm run install:all              # this repo + Realx8-Ui next door
npm run dev:all                  # backend + web app, one terminal
```

Then open http://localhost:5173. For the backend on its own, `npm start` serves
the whole API on http://localhost:3000.

**Day-to-day development, the WebStorm setup, and pointing at your existing
database: [RUNNING.md](RUNNING.md).**

## The idea

Every service in `services/` is still its own project — its own routes, models,
migrations, `package.json` and working `node src/index.js` entrypoint. Nothing
was merged.

What changed is how they are *composed*. `server.js` mounts each service's
express app into one process and calls it directly, so a request crosses the
network once instead of twice:

```
      Realx8-Ui
          │  one base URL (/api)
          ▼
  ┌───────────────────────────────────────────────┐
  │ edge      cors · helmet · rate limit · JWT    │   platform/edge.js
  ├───────────────────────────────────────────────┤
  │ dispatch  /invoices → finance, /leads → crm   │   platform/registry.js
  ├───────────────────────────────────────────────┤
  │ auth  user  property  investment  crm         │   services/*/src
  │ finance  notification  support                │   (plain function calls)
  └───────────────────────────────────────────────┘
                        │
                    one MySQL
```

The dispatcher does not care whether a service is in this process or on another
host. That is the whole splitting mechanism: `SERVICES` names the ones this
process owns, and every prefix it does not own is proxied to
`<NAME>_SERVICE_URL` over the same routing table. Peeling a service off is a
deploy-config change, not a rewrite — and the URLs Realx8-Ui calls never move.

## Layout

```
server.js                 composition root — the default entrypoint
platform/
  registry.js             which service owns which URL prefix (single source of truth)
  edge.js                 cors, helmet, rate limit, public/optional/required auth
  dispatcher.js           prefix -> service, indifferent to where it runs
  proxyHandler.js         ...when the service is another deployment
  boot.js                 ordered, sequential DB bootstrap
  routes.js               `npm run routes` — prints the live composition
services/
  api-gateway/            edge-only entrypoint, for the fully split shape
  auth-service/           /auth
  user-service/           /users /roles /settings /companies /uploads ...
  property-service/       /properties /inspections /public ...
  investment-service/     /investments /investment-plans ...
  crm-service/            /leads /deals /pipelines ...
  finance-service/        /invoices /transactions /commissions ...
  notification-service/   /notifications /notification-templates
  support-service/        /support /assistant /care ...
shared/                   JWT middleware, notifier, share links, email templates
cred.env.example          every environment variable, documented
```

## Scripts

| | |
|---|---|
| `npm run dev:all` | backend + web app together, one terminal |
| `npm start` | the whole API, one process, port 3000 |
| `npm run dev` | same, with reload on change |
| `npm run install:all` | install this repo and Realx8-Ui |
| `npm run routes` | print which service owns what, and what is proxied |
| `npm run dev:split` | nine processes + gateway, the pre-consolidation topology |
| `npm run seed` | seed reference data |
| `npm run security:config` | print the effective security posture, and what is worth checking |
| `npm run payload:bootstrap-key` | the `VITE_PAYLOAD_BOOTSTRAP_KEY` the UI needs |
| `npm run verify:purchase` | exercise the purchase & payment journey against a throwaway database |
| `npm run verify:list` | search, filter, sort and export, including tenant isolation |
| `npm run verify:security` | the security filters, against a running server |
| `npm run verify:session` | the one-session-per-user rule, against a real Redis |
| `npm run verify:cache` | cache isolation between companies and users |
| `npm run verify:crypto` | payload encryption end to end |
| `npm run docker:up` | API + MySQL + Redis in Docker |
| `npm run docker:split:up` | the per-service Docker topology |

## Listing, filtering and export

Every list endpoint built with `buildCrudController` accepts the same query
parameters, because they are implemented once in `shared/src/listQuery.js`
rather than per service:

```
?search=alpha                       across the model's text columns
?filter[status]=draft,sent          equality, or IN when comma-separated
?filter[amount][gte]=5000           eq ne gt gte lt lte like in notIn between
?filter[issued_at][between]=a,b     compared as dates, not as strings
?sort=-created_at,name              a leading minus is descending
?export=true                        the whole filtered set, not one page
```

The filterable columns are read from the model itself, so a new table has all
of this the day it exists. Three rules are worth knowing, each of which exists
because the alternative fails quietly:

- **An unknown column is a 400, not an ignored parameter.** `filter[stauts]=draft`
  returning every row would look exactly like a filtered answer, and somebody
  would file it as one.
- **A filter can never widen the company scope.** Clauses are combined with
  `Op.and`, so a caller's clause cannot overwrite the tenant scope the way a
  merged object would. `company_id` is refused as a filter outright; a platform
  admin narrows with `?company_id=`.
- **`password`, `passcode_hash`, `two_factor_secret` and their kin can be
  neither queried nor returned.** Filtering is an oracle, and a list that
  serialised the row wholesale used to put bcrypt hashes in the response body.

Exports are capped at 10,000 rows and the response says when the cap bit
(`pagination.truncated`), because a report silently missing its tail is worse
than one that admits it.

## Routes

67 prefixes, each served at both `/x` and `/api/x` (the UI calls the latter).
`npm run routes` lists them. 66 carried over unchanged from before the split;
`/payments` is new — see below.

Auth is applied once, at the edge, in every deployment shape — a service is
never reachable without it. The public endpoints are the login/registration/
password-reset flows, `/roles`, `/health` and the shared-link resolver; they are
listed explicitly in `platform/edge.js`.

## Database

One MySQL database, shared by every service, exactly as before. Each service
owns its own tables and a few deliberately read each other's (property-service
writes an invoice so a purchase and its invoice commit together; the notifier
reads `users` and `settings`). Those places are commented where they occur.

Because they share a database, migration order matters. In one process
`platform/boot.js` runs them **sequentially**, user-service first — it owns
`users`, `companies` and `settings`, which the others read during their own
migrations. Nine services booting at once cannot guarantee that, which is one
reason the single process is the recommended default.

A brand-new empty database bootstraps itself: user-service creates the baseline
schema before running migrations that assume it exists.

## Payment gateways

`POST /payments/{stripe/intent,paystack/verify,flutterwave/verify}` back the
**Test** button in Settings → Payment Gateways. Each takes the secret key saved
for the caller's company (falling back to the platform-wide one, the same
override rule as SMTP), asks the gateway whether it is valid, and reports the
answer with the key's environment — a test key saved in production is the
failure this exists to catch. Read-only at the gateway, admin-only, and the key
is never echoed back.

They do **not** charge anything. Nothing in the product charges a card: invoices
are settled by bank transfer with a receipt upload, and the
stripe/paystack/flutterwave options on "Record Payment" are labels on a manually
entered payment. A charge-shaped request gets an explicit 501 rather than a
response implying money moved.

The web app called these three paths before this repo existed, and nothing
served them — they returned 404 from the gateway. `finance-service` owns them
now.

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for all four shapes, including the exact
steps to split a service out later. The short version: deploy this repo, run
`npm start`, set `CORS_ORIGIN` to wherever Realx8-Ui is served.

## Changing things

**A new endpoint on an existing service** — add the route in that service. If it
sits under a prefix the service already owns, nothing else to do.

**A new URL prefix** — add it to that service's `prefixes` in
`platform/registry.js`. Both the composed server and the gateway pick it up.

**A new service** — scaffold it like the others (`app`, `bootstrap`, `start`
exports; skip cors/helmet/morgan when `isEmbedded()`), then add one entry to the
registry.
