const { getUsers, saveUsers } = require('../lib/db');

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
      if (!body.username) return res.status(400).json({ error: 'Username required' });
      if (users.some((u) => u.username === body.username)) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      const newUser = {
        id: 'U-' + Date.now(),
        username: body.username,
        password: body.password || 'Change@123',
        role: body.role || 'Agent',
        email: body.email || '',
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
      if (body.username && users.some((u) => u.username === body.username && u.id !== body.id)) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      const updated = { ...users[idx], ...body };
      if (!body.password) updated.password = users[idx].password; // keep existing if blank
      users[idx] = updated;
      await saveUsers(users);
      return res.status(200).json(publicUser(updated));
    }

    if (req.method === 'DELETE') {
      const users = await getUsers();
      const id = req.query.id || (req.body && req.body.id);
      if (users.length <= 1) return res.status(400).json({ error: "Can't remove the last user" });
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
