const { getCronState } = require('../lib/db');

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const state = await getCronState();
    const nextDueAt = state.lastRunAt ? state.lastRunAt + FORTY_EIGHT_HOURS_MS : null;
    return res.status(200).json({
      status: state.status || 'idle',
      lastRunAt: state.lastRunAt,
      lastStartedAt: state.lastStartedAt,
      nextDueAt,
      lastResult: state.lastResult || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
