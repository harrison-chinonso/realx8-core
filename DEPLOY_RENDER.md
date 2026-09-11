# Deploying to Render + Aiven MySQL + Upstash Redis (free tier)

This is the concrete, step-by-step version of the "Render" option in
DEPLOYMENT.md, using external free databases since Render's own free Postgres
isn't MySQL and expires after 30 days.

## What's already done in the repo

- `render.yaml` — a Render Blueprint that deploys this service with
  `npm start`, healthcheck `/health`, and `JWT_SECRET` /
  `PAYLOAD_ENCRYPTION_SECRET` auto-generated on first deploy.
- `services/*/src/config/database.js` — all eight services now support TLS
  (`DB_SSL=true`), which Aiven's managed MySQL requires. Previously there was
  no SSL support at all, so a managed MySQL connection would have failed.
- A fixed value for `SECURITY_FRONTEND_SECRET` below, so the backend
  (Render) and frontend (Vercel) can share the identical secret without a
  dashboard-to-dashboard copy step introducing a typo:

  ```
  SECURITY_FRONTEND_SECRET=3e6aeff9504079ef5a1958c6f03bfb038b4afb545e2cd93905e59afce1befe45
  ```

Everything below this line requires a human — account creation, clicking
through dashboards, and copying credentials between them are things I can't
do on your behalf.

---

## Step 1 — Create the MySQL database (Aiven)

1. Go to https://aiven.io and sign up (GitHub sign-in is fastest).
2. **Create service** → choose **MySQL** → free plan → any region close to you.
3. Wait ~2–3 minutes for it to go from "Rebuilding" to "Running".
4. Open the service → **Overview** tab → note down, under "Connection
   Information":
   - Host
   - Port
   - User (usually `avnadmin`)
   - Password
   - Default database name (usually `defaultdb`) — you can use this, or
     create a new one called `realto` from the **Databases** tab.
5. Keep this tab open; you'll paste these into Render in Step 3.

## Step 2 — Create the Redis cache (Upstash)

1. Go to https://upstash.com and sign up (GitHub sign-in works).
2. **Create Database** → name it, choose the region closest to your Render
   region, leave it on the free plan.
3. Open the database → in the **Details** panel, copy the **`redis://...`**
   connection string shown under "Node/ioredis" (not the REST URL — this repo
   uses `ioredis`, which needs the `redis://` form, not the `https://` REST
   API form).

## Step 3 — Deploy the backend (Render)

1. Go to https://render.com and sign up / log in (GitHub sign-in recommended
   — it also lets Render read your repos).
2. **New** → **Blueprint** → connect the `realx8-core` GitHub repo. Render
   will read `render.yaml` automatically.
3. Render will list the env vars marked `sync: false` and ask you to fill
   them in before the first deploy. Enter:
   - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — from Step 1.
   - `REDIS_URL` — from Step 2.
   - `SECURITY_FRONTEND_SECRET` — paste the fixed value shown above.
   - `CORS_ORIGIN` and `FRONTEND_URL` — put a placeholder for now, e.g.
     `https://placeholder.vercel.app` (you'll fix this in Step 5, once the
     real Vercel URL exists — Render won't let the blueprint deploy with
     these left empty).
4. Click **Apply** / **Create Web Service**. First deploy takes a few
   minutes (installs deps, then runs migrations on boot).
5. Once live, open the service URL Render gives you (something like
   `https://realx8-core.onrender.com`) and visit `/health` — you should see
   JSON reporting `"status": "ok"`. If it instead errors or the service
   crashes on boot, open the **Logs** tab — most likely cause at this point
   is a copy-paste mistake in the DB or Redis credentials.

## Step 4 — Deploy the frontend (Vercel)

1. Go to https://vercel.com and sign up / log in (GitHub sign-in).
2. **Add New** → **Project** → import the `realx8-ui` GitHub repo. Vercel
   auto-detects Vite; leave build settings as-is.
3. Before deploying, open **Environment Variables** and add:
   - `VITE_API_BASE_URL` = `https://<your-render-service>.onrender.com/api`
     (the exact URL from Step 3.5).
   - `VITE_FRONTEND_APP_ID` = `realx8-ui`
   - `VITE_FRONTEND_SECRET` = the same fixed value from the top of this file.
   - `VITE_FRONTEND_HEADER_NAME` = `X-Realx8-Auth`
   - `VITE_PAYLOAD_ENCRYPTION` = `off`
   - `VITE_DEVTOOLS_DETERRENCE` = `on`
4. Click **Deploy**. Once done, note the assigned URL (e.g.
   `https://realx8-ui.vercel.app`).

## Step 5 — Close the loop: point the backend at the real frontend URL

1. Back in Render → your service → **Environment**.
2. Update:
   - `CORS_ORIGIN` = `https://realx8-ui.vercel.app` (your real Vercel URL,
     no trailing slash).
   - `FRONTEND_URL` = same value.
3. Save — Render redeploys automatically with the new values.

## Step 6 — Verify end to end

1. Open your Vercel URL in a browser.
2. Try signing up / logging in. If the browser console shows a CORS error,
   double check `CORS_ORIGIN` in Render matches the Vercel URL exactly
   (scheme + host, no trailing slash).
3. If login succeeds but calls fail with 403, `SECURITY_FRONTEND_SECRET`
   (Render) and `VITE_FRONTEND_SECRET` (Vercel) don't match — re-check both.

## Notes specific to this setup

- **Cold starts**: Render's free web service spins down after 15 minutes
  idle; the first request after that takes ~30–50 seconds. Fine for a
  dev/demo phase — mention it to anyone you send a live link to, so a slow
  first load doesn't read as broken.
- **Optional integrations** (Google OAuth, SMTP email, Cloudinary uploads,
  social APIs) are left blank in `render.yaml`. The app runs fine without
  them; wire them up later by adding the corresponding vars from
  `cred.env.example` in the Render dashboard when you actually need them.
- **Uploads**: `user-service` writes to local disk under `uploads/`, which
  does **not** persist on Render's free plan across deploys/restarts.
  Fine for a demo; if you need uploaded files to survive, add Cloudinary
  (already wired in, just needs credentials) or a persistent disk (paid).
