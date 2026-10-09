const { getUsers, saveUsers } = require('../lib/db');

const VALID_ROLES = new Set(['Agent', 'Super Admin']);

// Strips password before sending user objects to the client.
function publicUser(u) {
  const { password, ...rest } = u;
  return rest;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const users = await getUsers();
      return res.status(200).json(users.map(publicUser));
    }

    if (req.method === 'POST') {
      const users = await getUsers();
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!username) return res.status(400).json({ error: 'Username required' });
      if (typeof body.password !== 'string' || body.password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      const role = body.role || 'Agent';
      if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
      if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      const newUser = {
        id: 'U-' + Date.now(),
        username,
        password: body.password,
        role,
        email: typeof body.email === 'string' ? body.email.trim() : '',
      };
      users.push(newUser);
      await saveUsers(users);
      return res.status(201).json(publicUser(newUser));
    }

    if (req.method === 'PUT') {
      const users = await getUsers();
      const body = req.body || {};
      const idx = users.findIndex((u) => u.id === body.id);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });
      const username = typeof body.username === 'string' ? body.username.trim() : users[idx].username;
      if (!username) return res.status(400).json({ error: 'Username required' });
      if (users.some((u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== body.id)) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      const role = body.role || users[idx].role;
      if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
      if (body.password && (typeof body.password !== 'string' || body.password.length < 4)) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      const remainingSuperAdmins = users.filter((u) => u.role === 'Super Admin' && u.id !== body.id);
      if (users[idx].role === 'Super Admin' && role !== 'Super Admin' && remainingSuperAdmins.length === 0) {
        return res.status(400).json({ error: 'At least one Super Admin must remain' });
      }
      const updated = {
        ...users[idx],
        username,
        email: typeof body.email === 'string' ? body.email.trim() : users[idx].email || '',
        role,
      };
      if (typeof body.password === 'string' && body.password) updated.password = body.password;
      users[idx] = updated;
      await saveUsers(users);
      return res.status(200).json(publicUser(updated));
    }

    if (req.method === 'DELETE') {
      const users = await getUsers();
      const id = req.query.id || (req.body && req.body.id);
      if (users.length <= 1) return res.status(400).json({ error: "Can't remove the last user" });
      const target = users.find((u) => u.id === id);
      if (target && target.role === 'Super Admin' && users.filter((u) => u.role === 'Super Admin').length <= 1) {
        return res.status(400).json({ error: 'At least one Super Admin must remain' });
      }
      const next = users.filter((u) => u.id !== id);
      await saveUsers(next);
      return res.status(200).json({ deleted: id });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
