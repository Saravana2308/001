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

module.exports = { getLeads, saveLeads, getUsers, saveUsers, resetLeads, hasKv };
