const { getUsers } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, password } = req.body || {};
    const users = await getUsers();
    const match = users.find((u) => u.username === username && u.password === password);

    if (!match) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const { password: _pw, ...publicUser } = match;
    // NOTE: this is a simple demo auth check, not a secure session/token system.
    // It's fine for a small internal tool but don't treat it as production-grade
    // auth for sensitive data - see README.md for the caveat.
    return res.status(200).json(publicUser);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
