const { hasKv } = require('../lib/db');
const { hasOxylabsKey } = require('../lib/oxylabs');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Only ever return booleans - never the actual secret values.
  return res.status(200).json({
    googlePlacesConnected: !!process.env.GOOGLE_PLACES_API_KEY,
    oxylabsWebApiConnected: hasOxylabsKey(), // Oxylabs Web API = primary data scrape
    cronSecretSet: !!process.env.CRON_SECRET,
    persistentStorage: hasKv, // true = Vercel KV attached, false = in-memory fallback
  });
};
