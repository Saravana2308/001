const { getOptOuts, saveOptOuts } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getOptOuts());
    }
    if (req.method === 'POST') {
      const list = await getOptOuts();
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: 'Name or company required' });
      list.push({ id: 'O-' + Date.now(), name: body.name, reason: body.reason || '', addedAt: new Date().toISOString() });
      await saveOptOuts(list);
      return res.status(201).json(list);
    }
    if (req.method === 'DELETE') {
      const list = await getOptOuts();
      const id = req.query.id || (req.body && req.body.id);
      await saveOptOuts(list.filter((o) => o.id !== id));
      return res.status(200).json({ deleted: id });
    }
    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
