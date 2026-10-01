const { getLeads, saveLeads } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const leads = await getLeads();
      return res.status(200).json(leads);
    }

    if (req.method === 'POST') {
      const leads = await getLeads();
      const body = req.body || {};
      const newLead = {
        id: 'L-' + Date.now(),
        name: body.name || '',
        category: body.category || 'Other',
        locality: body.locality || 'Other',
        address: body.address || '',
        phone: body.phone || '',
        rating: body.rating || null,
        reviews: body.reviews || 0,
        noWebsite: false,
        status: 'New',
        assignedTo: body.assignedTo || '',
        notes: '',
        createdAt: new Date().toISOString(),
      };
      leads.push(newLead);
      await saveLeads(leads);
      return res.status(201).json(newLead);
    }

    if (req.method === 'PUT') {
      const leads = await getLeads();
      const body = req.body || {};
      const idx = leads.findIndex((l) => l.id === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
      leads[idx] = { ...leads[idx], ...body };
      await saveLeads(leads);
      return res.status(200).json(leads[idx]);
    }

    if (req.method === 'DELETE') {
      const leads = await getLeads();
      const id = req.query.id || (req.body && req.body.id);
      const next = leads.filter((l) => l.id !== id);
      await saveLeads(next);
      return res.status(200).json({ deleted: id });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
