# Lead Generator (Lead Tools)

A lead management dashboard - Dashboard with charts, full CRUD on leads,
role-based Users management (Super Admin / Agent) - backed by a real API
instead of the browser's local storage.

## Project structure

```
lead-generator/
├── api/
│   ├── leads.js     GET/POST/PUT/DELETE  - lead records
│   ├── users.js     GET/POST/PUT/DELETE  - user accounts (Super Admin/Agent)
│   ├── login.js     POST                 - checks username/password
│   └── reset.js     POST                 - restores leads to the seed data
├── lib/
│   └── db.js        storage layer (Vercel KV, with in-memory fallback)
├── data/
│   ├── leads.seed.json   the 269 real leads gathered so far
│   └── users.seed.json   default Super Admin + Agent accounts
├── public/
│   └── index.html   the whole front-end (one file, no build step)
├── package.json
├── vercel.json
└── .gitignore
```

## IMPORTANT - read this before you call it "done"

This backend works two ways depending on whether a database is attached:

- **Without a database attached:** the API falls back to an in-memory store.
  It works for trying the app out, but **data can reset** whenever the
  serverless function cold-starts (Vercel doesn't keep serverless functions
  "warm" forever, and each instance has its own memory - there's no shared
  state between them). Fine for a demo, not fine for real use.

- **With Vercel KV attached (recommended, takes ~2 minutes):** all reads and
  writes persist permanently in a real Redis-backed store. This is what
  "the backend actually works" means in production. Steps are in the Vercel
  Deploy section below.

Also: the login system checks real credentials against the backend now
(`/api/login`), but it's still a **simple check, not a secure session
system** - no signed tokens, no encryption, no rate limiting on login
attempts. That's an appropriate trade-off for a small internal tool used by
a couple of people; it is **not** appropriate if this will ever hold data
you can't afford to leak, or be exposed to the public internet without
further hardening.

## Default logins

- Super Admin: `Patrick` / `Test@123`
- Agent: `agent` / `Agent@123`

Change these from the Users tab (Super Admin only) once you're live -
they're seed data, everyone reading this README knows them.

## 1. Push this to GitHub (repo name: lead-generator)

Run these from inside this folder:

```bash
git init
git add .
git commit -m "Initial commit - Lead Generator app with API backend"
```

Then create the empty repo on GitHub (I can't do this step - it needs your
GitHub login):

1. Go to https://github.com/new
2. Repository name: `lead-generator`
3. Leave it empty (no README/.gitignore/license - you already have those)
4. Click "Create repository"

GitHub will show you the remote URL. Connect and push:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/lead-generator.git
git push -u origin main
```

## 2. Deploy to Vercel

**Option A - CLI (fastest):**
```bash
npm i -g vercel
vercel
```
Follow the prompts (link to a new project, accept defaults). It'll deploy
immediately.

**Option B - Dashboard:**
1. Go to https://vercel.com/new
2. Import the `lead-generator` GitHub repo you just pushed
3. Framework Preset: **Other** (not Next.js - this isn't a Next app)
4. Root Directory: leave as `.` (default) - don't set a subfolder
5. Deploy

Either way you'll get a live `*.vercel.app` URL immediately - but at this
point you're running in the in-memory fallback (see the warning above).

## 3. Attach Vercel KV for real persistence (do this before going live)

1. In your Vercel project dashboard, go to the **Storage** tab
2. Click **Create Database** → choose **KV** (Upstash-backed Redis)
3. Follow the prompts to create it and connect it to this project
4. Vercel automatically sets the `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   environment variables for you - no manual config needed
5. Redeploy (Vercel usually prompts you to, or push any small commit)

Once that's done, `lib/db.js` will detect those env vars automatically and
every read/write goes to the real database. No code changes needed.

## Local development

```bash
npm install
vercel dev
```

`vercel dev` runs the API routes and static file serving locally, matching
production behavior (including reading local `.env` if you want to test
against a real KV instance from your machine too - copy the KV env vars
into a `.env.local` file for that).

## What's NOT included (be aware)

- No automated tests
- No CI/CD pipeline beyond Vercel's own git-push-to-deploy
- No rate limiting or brute-force protection on `/api/login`
- No HTTPS-only cookie/session - auth state lives in the browser's
  `sessionStorage`, which is fine for internal use, not for anything
  security-sensitive
