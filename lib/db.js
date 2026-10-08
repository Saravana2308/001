// lib/db.js
//
// Storage layer for Lead Generator.
//
// - If Vercel KV (Upstash Redis) env vars are present (KV_REST_API_URL /
//   KV_REST_API_TOKEN), all reads/writes go there and persist permanently.
// - If they are NOT present (e.g. first deploy before you attach a KV store,
//   or running `vercel dev` locally with no KV configured), this falls back
//   to an in-memory copy seeded from data/*.seed.json. That fallback is
//   NON-PERSISTENT on Vercel: serverless functions are stateless, so writes
//   in fallback mode may vanish on the next cold start. It's fine for
//   trying the app out, but for real persistent data you must attach KV
//   (see README.md - it's a few clicks in the Vercel dashboard).

const fs = require('fs');
const path = require('path');

let kv = null;
const hasKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

if (hasKv) {
  // Lazy require so this doesn't break local dev if the package isn't installed yet.
  try {
    kv = require('@vercel/kv').kv;
  } catch (e) {
    console.warn('[db] @vercel/kv not installed - falling back to in-memory store. Run `npm install` to enable it.');
  }
}

function loadSeed(file) {
  const p = path.join(process.cwd(), 'data', file);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// In-memory fallback store (per warm serverless instance only).
const memory = {
  leads: null,
  users: null,
};

async function getLeads() {
  if (kv) {
    const stored = await kv.get('leads');
    if (stored) return stored;
    const seed = loadSeed('leads.seed.json').map((l, i) => ({ id: 'L-' + (i + 1), ...l, createdAt: new Date().toISOString() }));
    await kv.set('leads', seed);
    return seed;
  }
  if (!memory.leads) {
    memory.leads = loadSeed('leads.seed.json').map((l, i) => ({ id: 'L-' + (i + 1), ...l, createdAt: new Date().toISOString() }));
  }
  return memory.leads;
}

async function saveLeads(leads) {
  if (kv) {
    await kv.set('leads', leads);
    return;
  }
  memory.leads = leads;
}

async function getUsers() {
  if (kv) {
    const stored = await kv.get('users');
    if (stored) return stored;
    const seed = loadSeed('users.seed.json');
    await kv.set('users', seed);
    return seed;
  }
  if (!memory.users) {
    memory.users = loadSeed('users.seed.json');
  }
  return memory.users;
}

async function saveUsers(users) {
  if (kv) {
    await kv.set('users', users);
    return;
  }
  memory.users = users;
}

async function resetLeads() {
  const seed = loadSeed('leads.seed.json').map((l, i) => ({ id: 'L-' + (i + 1), ...l, createdAt: new Date().toISOString() }));
  if (kv) {
    await kv.set('leads', seed);
  } else {
    memory.leads = seed;
  }
  return seed;
}

// Cron state: when the auto-refresh job last actually ran, and which index
// in data/regions.json it should start from next time (so repeated runs
// rotate through every region/category combo instead of hammering the same
// few every time).
const CRON_STATE_KEY = 'cronState';
const defaultCronState = {
  status: 'idle',       // 'idle' | 'running'
  lastRunAt: null,      // when a real (non-skipped) run last completed
  lastStartedAt: null,  // when the currently-running (or most recent) run started
  cursor: 0,
  lastResult: null,     // { leadsAdded, regionsProcessed, errors }
};

async function getCronState() {
  if (kv) {
    const stored = await kv.get(CRON_STATE_KEY);
    return stored || { ...defaultCronState };
  }
  if (!memory.cronState) memory.cronState = { ...defaultCronState };
  return memory.cronState;
}

async function saveCronState(state) {
  if (kv) {
    await kv.set(CRON_STATE_KEY, state);
    return;
  }
  memory.cronState = state;
}

// Saved Searches: a user's named, reusable ICP (industry/location/job
// title/company size/filters) so they can re-run "Brisbane Dental Owners"
// later without re-entering everything.
async function getSearches() {
  if (kv) {
    const stored = await kv.get('searches');
    return stored || [];
  }
  if (!memory.searches) memory.searches = [];
  return memory.searches;
}

async function saveSearches(searches) {
  if (kv) {
    await kv.set('searches', searches);
    return;
  }
  memory.searches = searches;
}

// Campaigns: draft-only. There is no connected email-sending provider, so
// "sending" a campaign in this app only ever moves it to a reviewable draft
// state - see api/campaigns.js and README.md for what would be needed to
// make sending real. Campaigns reference real leads (by id) from
// getLeads() - there is no separate/synthetic prospect pool.
async function getCampaigns() {
  if (kv) {
    const stored = await kv.get('campaigns');
    return stored || [];
  }
  if (!memory.campaigns) memory.campaigns = [];
  return memory.campaigns;
}

async function saveCampaigns(campaigns) {
  if (kv) {
    await kv.set('campaigns', campaigns);
    return;
  }
  memory.campaigns = campaigns;
}

// Do Not Contact / opt-out list - simple compliance record of
// companies/people who should be excluded from outreach.
async function getOptOuts() {
  if (kv) {
    const stored = await kv.get('optOuts');
    return stored || [];
  }
  if (!memory.optOuts) memory.optOuts = [];
  return memory.optOuts;
}

async function saveOptOuts(list) {
  if (kv) {
    await kv.set('optOuts', list);
    return;
  }
  memory.optOuts = list;
}

module.exports = {
  getLeads, saveLeads, getUsers, saveUsers, resetLeads,
  getCronState, saveCronState, getSearches, saveSearches,
  getCampaigns, saveCampaigns, getOptOuts, saveOptOuts,
  hasKv,
};
