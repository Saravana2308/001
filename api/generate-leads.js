const fs = require('fs');
const path = require('path');
const { getLeads, saveLeads } = require('../lib/db');
const { searchPlaces, normalizeKey, hasPlacesKey } = require('../lib/places');
const { scoreLead } = require('../lib/scoring');

const QUALITY_THRESHOLDS = {
  'Any Lead': 0,
  'Standard': 40,
  'High Quality': 60,
  'Highly Qualified': 75,
};

function loadIndustries() {
  const p = path.join(process.cwd(), 'data', 'industries.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function keywordsFor(industryName, industries) {
  const found = industries.find((i) => i.name.toLowerCase() === String(industryName).toLowerCase());
  if (found && found.keywords.length) return found.keywords[0];
  return industryName; // custom/free-text industry - search it literally
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const industries = Array.isArray(body.industries) ? body.industries : [];
  const locations = Array.isArray(body.locations) ? body.locations : [];
  const jobTitles = Array.isArray(body.jobTitles) ? body.jobTitles : [];
  const companySizes = Array.isArray(body.companySizes) ? body.companySizes : [];
  const leadCount = Math.min(Math.max(parseInt(body.leadCount, 10) || 100, 1), 1000);
  const leadQuality = body.leadQuality || 'High Quality';
  const requireEmail = !!body.requireEmail;
  const requireLinkedIn = !!body.requireLinkedIn;
  const requirePhone = !!body.requirePhone;
  const requireWebsite = !!body.requireWebsite;
  const keywords = (body.keywords || '').trim();
  const excludeKeywords = (body.excludeKeywords || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const minRating = body.minRating !== undefined && body.minRating !== null && body.minRating !== '' ? parseFloat(body.minRating) : null;
  const minReviews = body.minReviews !== undefined && body.minReviews !== null && body.minReviews !== '' ? parseInt(body.minReviews, 10) : null;

  // --- Friendly validation, matching the "almost ready" tone from the spec ---
  if (!industries.length) {
    return res.status(400).json({ friendlyError: "You're almost ready. Please select at least one target industry." });
  }
  if (!locations.length) {
    return res.status(400).json({ friendlyError: "You're almost ready. Please add at least one location." });
  }
  if (!jobTitles.length) {
    return res.status(400).json({ friendlyError: "You're almost ready. Please select who you want to reach (e.g. Owner, Manager)." });
  }
  if (!companySizes.length) {
    return res.status(400).json({ friendlyError: "You're almost ready. Please select a company size range." });
  }

  // --- Honest data-gap check: we have no email or LinkedIn data at all. ---
  // Rather than silently returning zero results with no explanation, say so.
  if (requireEmail || requireLinkedIn) {
    return res.status(200).json({
      leads: [],
      totalFound: 0,
      dataGap: `Verified email and LinkedIn data aren't available from the connected data source (Google Places) yet. `
        + `Uncheck "${requireEmail ? 'Verified Email Required' : ''}${requireEmail && requireLinkedIn ? '" and "' : ''}${requireLinkedIn ? 'LinkedIn Required' : ''}" to see company-level prospects, `
        + `or connect a contact-enrichment provider (e.g. Apollo, Hunter.io) to add this later.`,
    });
  }

  if (!hasPlacesKey()) {
    return res.status(200).json({
      leads: [],
      totalFound: 0,
      dataGap: 'No live business-data source is connected yet (GOOGLE_PLACES_API_KEY is not set), so there are no real prospects to show. '
        + 'Add that key in your Vercel project settings - see README.md.',
    });
  }

  try {
    const industryData = loadIndustries();
    const minScore = QUALITY_THRESHOLDS[leadQuality] ?? 60;

    // Build one query per industry x location combo.
    const queries = [];
    for (const industry of industries) {
      const kw = keywordsFor(industry, industryData);
      for (const loc of locations) {
        const place = loc.suburb || loc.city;
        const state = loc.state || '';
        const queryText = [kw, keywords].filter(Boolean).join(' ') + ` in ${place}${state ? ', ' + state : ''}`;
        queries.push({ industry, locality: place, state, query: queryText });
      }
    }

    const existingLeads = await getLeads();
    const existingKeys = new Set(existingLeads.map((l) => normalizeKey(l.name, l.address)));

    const results = await Promise.allSettled(
      queries.map((q) => searchPlaces(q.query).then((places) => ({ q, places })))
    );

    const candidates = [];
    const errors = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(String(result.reason));
        continue;
      }
      const { q, places } = result.value;
      for (const place of places) {
        const name = place.displayName && place.displayName.text ? place.displayName.text : '';
        const address = place.formattedAddress || '';
        if (!name) continue;

        const key = normalizeKey(name, address);
        if (existingKeys.has(key)) continue; // don't duplicate what's already in the leads list

        if (excludeKeywords.some((kw) => name.toLowerCase().includes(kw))) continue;

        const hasPhone = !!place.internationalPhoneNumber;
        const hasWebsite = !!place.websiteUri;
        if (requirePhone && !hasPhone) continue;
        if (requireWebsite && !hasWebsite) continue;

        const rating = typeof place.rating === 'number' ? place.rating : null;
        const reviews = typeof place.userRatingCount === 'number' ? place.userRatingCount : 0;
        if (minRating !== null && (rating === null || rating < minRating)) continue;
        if (minReviews !== null && reviews < minReviews) continue;
        const { score, band, reason } = scoreLead({ hasPhone, hasWebsite, rating, reviews, industry: q.industry, locality: q.locality });

        if (score < minScore) continue;

        existingKeys.add(key); // prevent dupes within this same batch too
        candidates.push({
          id: 'L-' + Date.now() + '-' + candidates.length,
          name,
          category: q.industry,
          industry: q.industry,
          locality: q.locality,
          address,
          phone: place.internationalPhoneNumber || '',
          website: place.websiteUri || '',
          rating,
          reviews,
          noWebsite: !hasWebsite,
          leadScore: score,
          leadBand: band,
          scoreReason: reason,
          targetTitles: jobTitles,        // who you WANT to reach here - not a confirmed contact
          targetCompanySize: companySizes,
          status: 'New',
          assignedTo: '',
          notes: '',
          source: 'generate',
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Best (highest-scoring) leads first, capped at the requested count.
    candidates.sort((a, b) => b.leadScore - a.leadScore);
    const finalLeads = candidates.slice(0, leadCount);

    const merged = existingLeads.concat(finalLeads);
    await saveLeads(merged);

    return res.status(200).json({
      leads: finalLeads,
      totalFound: finalLeads.length,
      requested: leadCount,
      queriesRun: queries.map((q) => q.query),
      errors: errors.length ? errors : undefined,
      note: finalLeads.length < leadCount
        ? `Found ${finalLeads.length} real prospect(s) matching your criteria - fewer than the ${leadCount} you asked for. `
          + `Try a wider location radius, a broader industry, or a lower lead-quality threshold for more results.`
        : undefined,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "We couldn't generate the leads right now. Please try again." });
  }
};
