# Deploying Realx8-Core

Four shapes, same code, same API. Pick the smallest one that meets the need and
move up only when something forces you to.

| Shape | Processes | When |
|---|---|---|
| **1. Single service** *(default)* | 1 | Now. Until a service needs its own resources. |
| **2. Partial split** | 2+ | One service is heavy or noisy — peel just that one off. |
| **3. Gateway + all services** | 10 | Every service needs independent scaling and releases. |
| **4. One service alone** | 1 | Debugging, or a worker deployment. |

Everything below is a change to environment variables and start commands. No
code changes, and Realx8-Ui is never reconfigured for any of it.

---

## 1. Single service — the default

One process serves all 66 route prefixes on one port.

```bash
npm ci
npm start           # honours $PORT, defaults to 3000
```

Required environment (see `cred.env.example` for the rest):

```
DB_HOST=  DB_PORT=3306  DB_NAME=realto  DB_USER=  DB_PASSWORD=
JWT_SECRET=<long random string>
CORS_ORIGIN=https://app.example.com     # where Realx8-Ui is served
TRUST_PROXY=1                           # if behind nginx / a load balancer
```

**Railway / Render / Fly** — deploy the repo, start command `npm start`,
healthcheck `/health`. `railway.json` already sets this.

**Docker**

```bash
docker compose up -d --build            # API + MySQL + Redis
curl localhost:3000/health
```

`CORS_ORIGIN` is the one that catches people out: if the origin serving
Realx8-Ui is not listed, the browser blocks every API call and the app looks
broken while the backend logs nothing wrong. `/health` reports the live
composition, so check it first after any change.

---

## 2. Partial split — peel one service off

Say `support-service` (the AI assistant) is holding up the event loop and you
want it isolated. Two deployments of **the same image**:

**Deployment A — the new support deployment**

```
SERVICES=support
PORT=3000
# same DB and JWT_SECRET as B
```

**Deployment B — everything else** (the existing one; add two variables)

```
SERVICES=user,auth,property,investment,crm,finance,notification
SUPPORT_SERVICE_URL=https://realx8-support.up.railway.app
```

Run `npm run routes` on either to see what it owns and what it forwards. B now
proxies `/support`, `/assistant`, `/visitors`, `/attendance` and `/care` to A
and serves the rest itself. Realx8-Ui keeps calling the same base URL and does
not know anything changed.

Repeat per service as needed. `SERVICES` must not be empty — a process that owns
no routes should be the gateway instead (shape 3).

Both deployments still share one database, so run migrations from one at a time
during a rollout.

---

## 3. Gateway + all services — the full split

Ten deployments: `services/api-gateway` for the edge, plus one per service.

```bash
npm run dev:split                              # locally
docker compose -f docker-compose.split.yml up  # in Docker
```

The gateway needs every `<NAME>_SERVICE_URL`:

```
AUTH_SERVICE_URL=https://...          # each service's own PORT: auth 3001,
USER_SERVICE_URL=https://...          # user 3002, property 3003,
PROPERTY_SERVICE_URL=https://...      # investment 3004, crm 3005,
INVESTMENT_SERVICE_URL=https://...    # finance 3006, notification 3007,
CRM_SERVICE_URL=https://...           # support 3008
FINANCE_SERVICE_URL=https://...
NOTIFICATION_SERVICE_URL=https://...
SUPPORT_SERVICE_URL=https://...
```

Each service runs `node services/<name>/src/index.js` from the repo root — not
from inside its own folder, because `shared/` resolves its dependencies from the
workspace root. `services/*/railway.json` and `services/*/Dockerfile` are set up
for this.

Shape 2 gets you most of the benefit for a fraction of the operational surface.
Reach for this one when you actually need per-service releases.

---

## 4. One service alone

```bash
node services/finance-service/src/index.js      # PORT=3006
```

It applies its own cors/helmet/morgan and serves its own prefixes unprefixed
(`/invoices`, not `/api/invoices`). Useful for debugging one service, or for
running a service as a private worker with no public route.

---

## Realx8-Ui

Deployed separately. Two ways to connect it, and the choice only affects the UI:

**Same-origin (recommended).** Something in front of the UI forwards `/api` to
this backend — the Vite dev server, the nginx in Realx8-Ui's Docker image, or a
Vercel rewrite. The UI keeps `VITE_API_BASE_URL=/api`, the browser stays
same-origin, and CORS never enters the picture.

**Cross-origin.** Build the UI with an absolute
`VITE_API_BASE_URL=https://api.example.com/api` and add that UI origin to
`CORS_ORIGIN` here. Note it is baked in at build time — Vite inlines it — so
changing it needs a rebuild, not a restart.

Preview hosts (`*.vercel.app`, `*.trycloudflare.com`, `*.pages.dev`) are
CORS-allowed automatically; see `shared/src/appOrigin.js`.

## Operational notes

- **`JWT_SECRET` must be identical everywhere.** The edge of every deployment
  verifies tokens with it; a mismatch logs everyone out of the split-off part.
- **`/health`** reports what a process owns and what it proxies. Use it as the
  platform healthcheck and as the first thing you check after a config change.
- **`TRUST_PROXY`** — set to the number of proxies in front of the app in
  production. Left unset, rate limiting keys on the proxy's IP, so one client can
  exhaust the limit for everyone.
- **Uploads** are on local disk under `uploads/`, served at `/uploads` by
  user-service. Mount a volume, or the files vanish on redeploy. If you split
  user-service out, only that deployment needs the volume.
- **Migrations run on boot** (`sequelize.sync()` plus each service's own).
  Sequential and ordered in one process; unordered across separate deployments.
