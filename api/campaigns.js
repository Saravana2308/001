const { getCampaigns, saveCampaigns } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const campaigns = await getCampaigns();
      return res.status(200).json(campaigns);
    }

    if (req.method === 'POST') {
      const campaigns = await getCampaigns();
      const body = req.body || {};
      const campaign = {
        id: 'C-' + Date.now(),
        name: body.name || 'Untitled campaign',
        sender: body.sender || '',
        subject: body.subject || '',
        body: body.body || '',
        followUps: body.followUps || [],
        leadIds: body.leadIds || [],
        status: 'Draft',
        createdAt: new Date().toISOString(),
      };
      campaigns.push(campaign);
      await saveCampaigns(campaigns);
      return res.status(201).json(campaign);
    }

    if (req.method === 'PUT') {
      const campaigns = await getCampaigns();
      const body = req.body || {};
      const idx = campaigns.findIndex((c) => c.id === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
      campaigns[idx] = { ...campaigns[idx], ...body };
      await saveCampaigns(campaigns);
      return res.status(200).json(campaigns[idx]);
    }

    if (req.method === 'DELETE') {
      const campaigns = await getCampaigns();
      const id = req.query.id || (req.body && req.body.id);
      await saveCampaigns(campaigns.filter((c) => c.id !== id));
      return res.status(200).json({ deleted: id });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
