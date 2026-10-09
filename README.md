# Lead Generator (Lead Tools)

A sales-prospecting dashboard: describe your ideal customer in plain
English (or use structured filters), generate real scored prospects from
Google Places, manage them through a full CRUD pipeline, with role-based
Users (Super Admin / Agent), saved searches, and an automatic 48-hour
refresh job - all backed by a real API instead of the browser's local
storage.

## Project structure

```
lead-generator/
├── api/
│   ├── leads.js             GET/POST/PUT/DELETE - lead/prospect records
│   ├── users.js              GET/POST/PUT/DELETE - user accounts (Super Admin/Agent)
│   ├── login.js               POST - checks username/password
│   ├── reset.js                POST - restores leads to the seed data
│   ├── generate-leads.js      POST - the Find Leads engine (ICP -> real prospects, scored)
│   ├── searches.js            GET/POST/DELETE - saved searches
│   ├── web-scrape.js          POST - PRIMARY data scrape: live web search + page reading (Oxylabs Web API)
│   ├── cron-refresh-leads.js  POST (cron) - auto-refresh, every 48h
│   └── cron-status.js         GET - status for the dashboard sync badge
├── lib/
│   ├── db.js        storage layer (Vercel KV, with in-memory fallback)
│   ├── places.js     shared Google Places API (New) search helper
│   ├── oxylabs.js    Oxylabs Web API client - search + scrape with the documented retry ladder
│   └── scoring.js    transparent 0-100 lead scoring engine
├── data/
│   ├── leads.seed.json     the 269 real leads gathered so far
│   ├── users.seed.json     default Super Admin + Agent accounts
│   ├── regions.json         category/locality combos the cron job rotates through
│   ├── industries.json      industry list + search keywords + default titles
│   └── locations.json       Australian state/city/suburb reference data
├── public/
│   ├── index.html   the whole front-end (one file, no build step)
│   └── data/         copies of industries.json/locations.json served statically
├── test/
│   └── oxylabs.test.js  mocked-transport tests for retries + error mapping (npm test)
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

## User access

Sign in as a Super Admin and open the **Users** tab to add as many accounts
as needed. Set a username, password (at least 4 characters), email, and role
for each account. Super Admins have access to every app section, including
user management and resetting demo leads; Agents can use the lead tools but
cannot open user management or reset the lead data. At least one Super Admin
must remain, and new accounts do not receive a shared default password.

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

## Automatic lead refresh (every 48 hours, 1:00 AM IST)

`api/cron-refresh-leads.js` automatically searches for new leads and adds
any it hasn't seen before (deduped by name + address), rotating through
every category/locality combination in `data/regions.json` a batch at a
time.

**How the schedule actually works:** Vercel Cron on the free Hobby plan can
only trigger a job once per day, not every 48 hours directly. So the cron
fires daily at **19:30 UTC = 1:00 AM IST** (`vercel.json` → `"schedule":
"30 19 * * *"`), but the function itself checks how long it's been since
its last real run and skips (returns `{skipped: true}`) if it's been less
than 48 hours. Net effect: it actually executes every 48 hours, on a plan
tier that only allows daily triggers.

**Required setup - this will NOT fetch real leads without it:**

1. Get a Google Cloud API key with the **Places API (New)** enabled and
   billing turned on (Google requires a billing account even within the
   free monthly quota: https://console.cloud.google.com/apis/library -
   search "Places API (New)").
2. In Vercel → your project → Settings → Environment Variables, add:
   - `GOOGLE_PLACES_API_KEY` = your key
   - `CRON_SECRET` = any random string you generate (e.g. `openssl rand
     -hex 32`). Vercel automatically sends this as a Bearer token when it
     triggers the cron, and the function checks it - this stops anyone
     else from hitting the endpoint and running up charges on your key.
3. Redeploy so the new env vars take effect.

**Without `GOOGLE_PLACES_API_KEY` set:** the job will run on schedule but
every region search will fail with a clear error in the response/logs -
nothing breaks, it just won't add anything. I could not test the actual
Google Places API calls myself (no network access in my build
environment) - test it manually once deployed (see below) before trusting
it to run unattended.

**Testing it manually without waiting for the schedule:**
```bash
curl -X POST https://<your-app>.vercel.app/api/cron-refresh-leads \
  -H "Authorization: Bearer <your CRON_SECRET value>"
```
Check the JSON response for `leadsAdded` and any `errors`. Run it twice in
a row - the second call should come back `{"skipped": true, ...}` since
it won't be 48 hours yet, which confirms the gate is working.

**Costs to be aware of:** Google Places API (New) Text Search is a paid
API beyond its free monthly credit. 10 regions per run × roughly 15 runs/
month (every 48h) = ~150 calls/month - check current Google pricing before
leaving this running long-term, and set a budget alert on the Google Cloud
project.

## Find Leads - how it actually works

The "Find Leads" page lets you describe your ideal customer in a text box
("Find dental clinics in Brisbane with 5-50 employees, I want the owner or
practice manager") or use the structured filters directly. Here's exactly
what's real and what isn't, because this is the part most likely to be
over-trusted if left unclear:

**Real:**
- Company name, address, phone, website, rating, review count - all live
  from Google Places (when `GOOGLE_PLACES_API_KEY` is set)
- Lead scoring (0-100, Hot/High Priority/Good/Medium/Low) - a transparent
  rule-based formula in `lib/scoring.js`, not a black box. Every point is
  traceable to a real field (has phone, has website, rating, review count).
  The "Why this lead?" text in the detail panel is generated from the same
  real signals, every time.
- Minimum rating / minimum reviews / phone-required / website-required
  filters - these genuinely filter against real Places data.

**Pattern-matching, not a connected AI model:**
- The "Generate ICP with AI" box does rule-based keyword/regex matching
  (industry keywords, known AU suburbs, "N-M employees" patterns, job-title
  keywords) against `data/industries.json` and `data/locations.json` - it's
  genuinely useful for the common cases the spec described, but it is
  **not** calling an LLM. The UI says this explicitly so it's never
  mistaken for more than it is. If you want true natural-language
  understanding later, this is the function to swap for a real LLM API call
  (e.g. the Claude API) - `parseICPFromText()` in `public/index.html`.

**Deliberately absent, not faked:**
- **No contact names, emails, or LinkedIn profiles.** Google Places (and
  no legitimate business-data API) returns owner/manager names or personal
  emails. The "Decision Maker / Job Title" filter records *who you want to
  reach* as a target, and the detail panel labels it "not confirmed" - it
  never invents a person's name to fill the field. Checking "Verified Email
  Required" or "LinkedIn Required" returns zero results with an explanation
  rather than fabricating matches. Real contact-level enrichment would need
  a separate provider (Apollo, Hunter.io, ZoomInfo, Clearbit) wired into
  `api/generate-leads.js` - a well-scoped next step, not done here.
- **No company size, revenue, or technology-stack data.** Places doesn't
  report employee counts or firmographics, so company size is recorded as
  what you're *targeting*, never presented as a verified fact about a
  specific business. The "More Filters" section only exposes filters
  actually backed by real data (rating, reviews, keywords) rather than
  showing a longer list of filters that silently do nothing.

## Scope: what this build explicitly leaves out

The original spec described a full sales-intelligence SaaS platform
(33 sections: campaigns, CRM sync, a multi-chart analytics suite, duplicate
detection, onboarding wizard, mobile card view, and more). Building all of
that in one pass - especially the parts needing real external
integrations I have no credentials for - would have meant a lot of
half-working scaffolding. Built instead, for real:

- Find Leads (ICP prompt + structured filters) → real scored prospects
- Lead scoring + "why this lead" + detail panel with draft outreach copy
- Prospects/Leads table (existing CRUD, now with a Score column)
- Saved Searches (save, list, run again, delete)
- Automatic 48-hour refresh + dashboard sync status badge

**Not built - would need real integrations or significant further work:**
- Email campaign **sending** (SMTP/SendGrid-type provider not connected -
  building the compose/review UI without real sending would be a product
  that silently can't do its one job)
- CRM sync (HubSpot/Salesforce/Zoho/Pipedrive - all need OAuth app
  registration + credentials)
- The full analytics chart suite (funnel, open rate, campaign performance -
  most of these need campaign/email data that doesn't exist yet)
- Duplicate-detection UI, first-time onboarding wizard, mobile card layout
- Excel export (CSV export already works; Excel is a quick follow-up)

Happy to build any of these next - just say which, and whether you have
credentials for the relevant service (email provider, CRM) ready to go.


## Feature overview (AI prospecting platform)

| Area | What it does | Real or limited? |
|---|---|---|
| Dashboard | Total / New / Qualified / Hot leads, Verified Emails, Appointments, Conversion Rate, charts, sync status | Real, from your lead data |
| Find Leads | Describe your customer in plain English, or fill structured filters; ICP is parsed, shown for confirmation, then leads are generated | Parsing is **rule-based pattern matching**, not an LLM. Lead generation uses the **Google Places API** (needs `GOOGLE_PLACES_API_KEY`) |
| Lead scoring | 0-100 score with Hot / High Priority / Good / Medium / Low bands and a "why this lead" explanation | Real logic, based on signals actually available (phone, website, rating, reviews, match) |
| Leads table | Filters (category, locality, status, user, score, date added), bulk select, bulk status change, bulk delete, CSV + Excel export (all / selected / hot / high-quality), detail side panel with draft email, opening line and call script | Real |
| Duplicate detection | Prompts Keep Existing / Replace / Merge / Add Anyway when adding a matching lead | Real |
| Smart suggestions | Suggests decision-maker titles and search terms for the chosen industry (never auto-applied) | Rule-based |
| Saved Searches | Save, run again, delete | Real |
| Campaigns | Draft emails with merge fields, 6 angles, 3 follow-ups with delays, preview | **Draft-only. No email is ever sent.** Needs an email provider (SendGrid, Postmark, SMTP) to become real |
| CRM | Field mapping + CSV export formatted for HubSpot / Salesforce / Zoho / Pipedrive import | **No live sync.** Real connectors need an OAuth app registered with each CRM |
| Analytics | Leads over time, quality distribution, industry and location performance | Real. Email open/reply/funnel charts are intentionally empty until sending is connected, so no numbers are invented |
| Settings | Integration status, Do Not Contact list, privacy / terms placeholders | Policy text is placeholder, **not legal advice** |
| Onboarding | 4-question guided start for brand-new (empty) accounts | Real |

### What is deliberately NOT faked
- **Contact names, personal emails and LinkedIn profiles are not generated.** Google Places returns company-level data only, and inventing a person's name or email for a real business would be misleading. The Email column shows "Not available" until you connect an enrichment provider (e.g. Apollo, Hunter, ZoomInfo).
- **Verification badges only claim what is true**: nothing is labelled "Verified" unless a real check set it.
- The "AI" in this app is rule-based. To use a real LLM for ICP parsing or email writing, add an LLM API key and call it from a new serverless function.

### Extra API routes
`/api/generate-leads`, `/api/searches`, `/api/campaigns`, `/api/opt-outs`, `/api/settings-status`, `/api/cron-status`, `/api/cron-refresh-leads`, `/api/web-scrape`

### Oxylabs Web API - primary data scrape

Live web search and page reading come from the **Oxylabs Web API**
(`https://webapi.oxylabs.io`), integrated in `lib/oxylabs.js` and exposed as
`POST /api/web-scrape`. The pattern is search -> scrape: one search finds the
pages, then the top 1-3 are actually read - search snippets are truncated and
often stale, so nothing is ever answered from them.

- **Setup:** set `OXYLABS_WEB_API_KEY` in the environment (`.env` for
  `vercel dev` - it is gitignored and must never be committed). Without it,
  `/api/web-scrape` fails with a clear "key is not set" message.
  `/api/settings-status` reports `oxylabsWebApiConnected` as a boolean; the
  key itself is never returned, logged, or embedded in errors.
- **Endpoints:** `POST /v1/search` (ranked results: title, snippet, URL) and
  `POST /v1/scrape` (page content as markdown), each with an
  `Authorization: Bearer` header on every call and a ~120 s client timeout.
- **Retries:** transport timeouts and `408`/`429`/`5xx` only, exponential
  backoff with jitter, max 3 attempts. `400`/`401` are never retried: `400`
  surfaces the failing field name (`errors[].pointer`), `401` stops with a
  clear message. Success is any `2xx`.
- **Empty pages:** a scrape that comes back empty or skeletal is retried once
  with `run_js: true`; if it is still empty and the site is on a country TLD
  (`.lt` -> `LT`, `.co.uk` -> `GB`, brand-use ccTLDs like `.io`/`.ai`/`.co`/
  `.me` skipped) it is retried once more with `run_js` + that `location`,
  then reported as unreadable instead of guessing content.
- **Reportable failures:** every success and error carries
  `metadata.request_id`, so any problem can be traced with Oxylabs support.
- **Tests:** `npm test` runs `test/oxylabs.test.js` against a mocked
  transport (retry ladder, backoff timing, 400/401/404/5xx mapping, key
  never leaked) using a dummy key of its own - no real network, no real key.

## What's NOT included (be aware)

- Automated tests cover only the Oxylabs web-scrape client (`npm test`);
  the rest of the app still has none
- No CI/CD pipeline beyond Vercel's own git-push-to-deploy
- No rate limiting or brute-force protection on `/api/login`
- No HTTPS-only cookie/session - auth state lives in the browser's
  `sessionStorage`, which is fine for internal use, not for anything
  security-sensitive
