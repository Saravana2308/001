const fs = require('fs');
const path = require('path');
const { getLeads, saveLeads, getUsers, saveUsers } = require('../lib/db');

// Merges any leads/users that exist in the bundled seed files but are missing
// from the live store. Existing records are never overwritten or removed, so
// edits, statuses, notes and assignments are preserved.
//
// Why this exists: once Vercel KV has been seeded, changing data/*.seed.json
// does NOT change the stored data. This endpoint is how new bundled leads
// (and new default users) get into an already-running deployment.
//
// NOTE: like the rest of this app's auth, the "Super Admin only" button is a
// client-side gate, not server-enforced security.

function readSeed(file) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', file), 'utf-8'));
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const seedLeads = readSeed('leads.seed.json');
    const seedUsers = readSeed('users.seed.json');

    const leads = await getLeads();
    const keys = new Set(leads.map((l) => norm(l.name) + '|' + norm(l.address)));
    const ids = new Set(leads.map((l) => l.id));
    let leadsAdded = 0;
    seedLeads.forEach((l, i) => {
      const key = norm(l.name) + '|' + norm(l.address);
      if (keys.has(key)) return;
      let id = 'L-' + (i + 1);
      if (ids.has(id)) id = 'L-' + Date.now() + '-' + i;
      ids.add(id);
      keys.add(key);
      leads.push({ id, ...l, createdAt: new Date().toISOString() });
      leadsAdded++;
    });
    if (leadsAdded) await saveLeads(leads);

    const users = await getUsers();
    const names = new Set(users.map((u) => u.username.toLowerCase()));
    let usersAdded = 0;
    seedUsers.forEach((u) => {
      if (names.has(u.username.toLowerCase())) return;
      let id = u.id;
      if (users.some((x) => x.id === id)) id = 'U-' + Date.now() + '-' + usersAdded;
      users.push({ ...u, id });
      names.add(u.username.toLowerCase());
      usersAdded++;
    });
    if (usersAdded) await saveUsers(users);

    return res.status(200).json({ leadsAdded, usersAdded, totalLeads: leads.length, totalUsers: users.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
