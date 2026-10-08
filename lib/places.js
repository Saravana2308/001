// lib/places.js
//
// Thin wrapper around the Google Places API (New) Text Search endpoint.
// Requires GOOGLE_PLACES_API_KEY. Used by both api/cron-refresh-leads.js
// and api/generate-leads.js so query behavior stays identical everywhere.
//
// IMPORTANT HONESTY NOTE: this API returns real business-level data (name,
// address, phone, website, rating, review count) but NEVER owner/manager
// names, emails, or LinkedIn profiles - no legitimate business-data API
// does, for privacy reasons. Code that consumes this must not invent those
// fields.

const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
].join(',');

async function searchPlaces(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set');
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Places API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.places || [];
}

function normalizeKey(name, address) {
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = (address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return n + '|' + a;
}

module.exports = { searchPlaces, normalizeKey, hasPlacesKey: () => !!process.env.GOOGLE_PLACES_API_KEY };
