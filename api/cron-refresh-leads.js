const fs = require('fs');
const path = require('path');
const { getLeads, saveLeads, getCronState, saveCronState } = require('../lib/db');
const { searchPlaces, normalizeKey } = require('../lib/places');
const { scoreLead } = require('../lib/scoring');

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const BATCH_SIZE = 10; // how many region/category combos to refresh per run

function loadRegions() {
  const p = path.join(process.cwd(), 'data', 'regions.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

module.exports = async (req, res) => {
  // Vercel Cron sends this header automatically when CRON_SECRET is set as
  // an env var - this stops anyone else from hitting the endpoint and
  // triggering API-billed searches on your Google Places key.
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const state = await getCronState();
    const now = Date.now();

    // The cron trigger itself fires daily (Vercel Hobby plan's minimum
    // interval) at 1:00 AM IST. This gate makes it actually act only every
    // other call, giving a true 48-hour cadence regardless of plan tier.
    if (state.lastRunAt && (now - state.lastRunAt) < FORTY_EIGHT_HOURS_MS) {
      return res.status(200).json({
        skipped: true,
        reason: 'Not due yet (runs every 48h)',
        lastRunAt: new Date(state.lastRunAt).toISOString(),
        nextRunDue: new Date(state.lastRunAt + FORTY_EIGHT_HOURS_MS).toISOString(),
      });
    }

    // Mark as running immediately so /api/cron-status can reflect it while
    // the searches below are in flight (they can take a few seconds).
    await saveCronState({ ...state, status: 'running', lastStartedAt: now });

    const regions = loadRegions();
    const leads = await getLeads();
    const existingKeys = new Set(leads.map((l) => normalizeKey(l.name, l.address)));

    // Rotate through the region list BATCH_SIZE at a time so one run never
    // has to make 40+ API calls (keeps it fast and within function time
    // limits on every Vercel plan tier).
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      batch.push(regions[(state.cursor + i) % regions.length]);
    }

    const results = await Promise.allSettled(
      batch.map((region) => searchPlaces(region.query).then((places) => ({ region, places })))
    );

    let added = 0;
    const errors = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(String(result.reason));
        continue;
      }
      const { region, places } = result.value;
      for (const place of places) {
        const name = place.displayName && place.displayName.text ? place.displayName.text : '';
        const address = place.formattedAddress || '';
        if (!name) continue;
        const key = normalizeKey(name, address);
        if (existingKeys.has(key)) continue; // already have this one - skip

        existingKeys.add(key);
        const rating = typeof place.rating === 'number' ? place.rating : null;
        const reviews = typeof place.userRatingCount === 'number' ? place.userRatingCount : 0;
        const hasPhone = !!place.internationalPhoneNumber;
        const hasWebsite = !!place.websiteUri;
        const { score, band, reason } = scoreLead({ hasPhone, hasWebsite, rating, reviews, industry: region.category, locality: region.locality });

        leads.push({
          id: 'L-' + Date.now() + '-' + added,
          name,
          category: region.category,
          industry: region.category,
          locality: region.locality,
          address,
          phone: place.internationalPhoneNumber || '',
          website: place.websiteUri || '',
          rating,
          reviews,
          noWebsite: !hasWebsite,
          leadScore: score,
          leadBand: band,
          scoreReason: reason,
          status: 'New',
          assignedTo: '',
          notes: '',
          source: 'cron',
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }

    await saveLeads(leads);
    const finalState = {
      status: 'idle',
      lastRunAt: now,
      lastStartedAt: now,
      cursor: (state.cursor + BATCH_SIZE) % regions.length,
      lastResult: {
        leadsAdded: added,
        regionsProcessed: batch.map((r) => r.query),
        errors: errors.length ? errors : null,
      },
    };
    await saveCronState(finalState);

    return res.status(200).json({
      skipped: false,
      regionsProcessed: batch.map((r) => r.query),
      leadsAdded: added,
      errors: errors.length ? errors : undefined,
      nextCursor: finalState.cursor,
    });
  } catch (err) {
    console.error(err);
    // Make sure we don't leave status stuck on "running" if something blew up.
    try {
      const state = await getCronState();
      await saveCronState({ ...state, status: 'idle' });
    } catch (e2) { /* best effort */ }
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
