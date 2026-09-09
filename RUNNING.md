# Running Realx8 in development

Same as before the split: **one command, one terminal, your existing database.**

```bash
npm run install:all      # first time only — installs both repos
npm run dev:all          # backend + web app together
```

Then open **http://localhost:5173**. That is the only URL you need; the app
proxies `/api` to the backend on :3000, exactly as it did before.

```
[core] Realx8-Core listening on 3000     ← all 9 services, one process
[ui]   VITE ready — http://localhost:5173
```

Ctrl-C stops both. Saving a backend file restarts the backend (nodemon);
saving a UI file hot-reloads in the browser (Vite HMR). No change there either.

## The database

Nothing to do. `cred.env` already points at your existing dev database:

```
DB_HOST=localhost  DB_PORT=3306  DB_NAME=realto  DB_USER=root  DB_PASSWORD=password
JWT_SECRET=super-secret-key   JWT_ACCESS_EXPIRES=1h   JWT_REFRESH_DAYS=7
CORS_ORIGIN=http://localhost:5173
```

Every value the backend actually reads is identical to the old
`realto-repros/cred.env`, so your existing data, users and logins work
unchanged. (`MYSQL_*`, `REDIS_URL` and `VITE_API_BASE_URL` were in that file but
no backend code reads them — they were compose/reference values. The UI reads
its own `.env`, which carries the same `/api` it always had.)

Migrations still run on boot, as they always did. The difference is they now run
**in order, one service at a time** instead of nine services racing each other
against the same schema.

`cred.env` is gitignored. `cred.env.example` is the tracked template.

## The commands

| | |
|---|---|
| `npm run dev:all` | backend + web app, one terminal ← **the everyday one** |
| `npm run dev` | backend only |
| `npm run dev --prefix ../Realx8-Ui` | web app only |
| `npm run routes` | print which service owns which URL prefix |
| `npm run dev:split` | the old nine-process topology, if you ever want to see it |
| `npm run install:all` | install both repos |

If you keep the UI somewhere other than next door:

```bash
UI_DIR=~/code/Realx8-Ui npm run dev:all
```

`scripts/dev-all.js` is the **only** place the two repos reference each other,
and only for local convenience — nothing in the Docker images, the deployment
configs or the running code reaches across.

## WebStorm: one window, two repos

Already set up. Open **Realx8-Core** and WebStorm shows both codebases as
content roots in the same project, with `Realx8-Ui` alongside `services/`,
`platform/` and `shared/`.

Run configurations are in the dropdown next to the ▶ button:

- **▶ Everything (core + ui)** — the one you want
- Backend only (core)
- Web app only (ui)
- Backend split (9 services)
- Show routing table

### Committing and pushing stays per-repository

The two roots keep their own `.git`, and WebStorm knows about both
(`.idea/vcs.xml`). So in one window:

- **Commit** (⌘K) groups changed files under the repository each belongs to —
  tick only the ones you mean.
- **Push** (⇧⌘K) asks per repository, and pushes to that repo's own remote.
- Branches, history and diffs are per repository. `Git → Branches` lists both
  roots separately.

There is no combined commit. A change to the backend and a change to the UI are
two commits in two repos, which is the point of splitting them — they deploy
independently.

### Adding remotes

Each repo has an initial commit and no remote yet:

```bash
cd Realx8-Core && git remote add origin git@github.com:<you>/Realx8-Core.git && git push -u origin main
cd ../Realx8-Ui  && git remote add origin git@github.com:<you>/Realx8-Ui.git  && git push -u origin main
```

### If the IDE setup ever needs recreating

`.idea/` is gitignored, so a fresh clone will not have it. Rebuild it in three
clicks: open `Realx8-Core`, then **File → Open**, pick `Realx8-Ui`, and choose
**Attach**. When WebStorm offers "unregistered VCS roots detected", accept it —
that registers the second Git root.

## What is genuinely different from before

Two things, both invisible while developing:

1. The frontend is a separate repo with its own `package.json` and git history.
   In the IDE it looks like another folder in the same project.
2. The backend no longer talks to itself over HTTP. Nine services still exist as
   nine separate projects under `services/`; `server.js` mounts them into one
   process and calls them directly. Same URLs, same auth, one less network hop.

Everything else — ports, routes, the database, logins, hot reload, the single
command — behaves as it did.
