const { getSearches, saveSearches } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const searches = await getSearches();
      return res.status(200).json(searches);
    }

    if (req.method === 'POST') {
      const searches = await getSearches();
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: 'Please name this search before saving it.' });
      const newSearch = {
        id: 'S-' + Date.now(),
        name: body.name,
        criteria: body.criteria || {},
        createdAt: new Date().toISOString(),
      };
      searches.push(newSearch);
      await saveSearches(searches);
      return res.status(201).json(newSearch);
    }

    if (req.method === 'DELETE') {
      const searches = await getSearches();
      const id = req.query.id || (req.body && req.body.id);
      const next = searches.filter((s) => s.id !== id);
      await saveSearches(next);
      return res.status(200).json({ deleted: id });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
