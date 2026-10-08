// lib/scoring.js
//
// A transparent, rule-based 0-100 lead score. Every point is traceable to
// a real field returned by Google Places - nothing here simulates company
// size, revenue, or decision-maker fit, because we don't have that data.
// scoreLead() returns both the number and a plain-English reason so the
// "Why this lead?" panel in the UI is never guessing.

const BANDS = [
  { min: 90, label: 'Hot' },
  { min: 75, label: 'High Priority' },
  { min: 60, label: 'Good' },
  { min: 40, label: 'Medium' },
  { min: 0, label: 'Low' },
];

function bandFor(score) {
  return BANDS.find((b) => score >= b.min).label;
}

function scoreLead({ hasPhone, hasWebsite, rating, reviews, industry, locality }) {
  let score = 0;
  const reasons = [];

  // Baseline: the result came from a search built directly from the
  // requested industry + location, so both match by construction.
  score += 20;
  reasons.push(`Matches your "${industry}" search in ${locality}`);

  score += 15; // location baseline (see above)

  if (hasPhone) {
    score += 15;
    reasons.push('has a listed phone number');
  }
  if (hasWebsite) {
    score += 15;
    reasons.push('has a website');
  } else {
    reasons.push('no website found - a possible digital-marketing opportunity');
  }

  if (typeof rating === 'number') {
    const ratingPoints = Math.round((rating / 5) * 20);
    score += ratingPoints;
    reasons.push(`${rating.toFixed(1)}\u2605 rating`);
  }

  if (typeof reviews === 'number') {
    let reviewPoints = 0;
    if (reviews >= 100) reviewPoints = 15;
    else if (reviews >= 20) reviewPoints = 10;
    else if (reviews >= 5) reviewPoints = 5;
    score += reviewPoints;
    if (reviews > 0) reasons.push(`${reviews} reviews`);
  }

  score = Math.max(0, Math.min(100, score));

  const reasonText = `${reasons.slice(0, -1).join(', ')}${reasons.length > 1 ? ', and ' : ''}${reasons[reasons.length - 1]}. `
    + 'Employee count and a named decision-maker contact are not available from this data source - verify directly before outreach.';

  return { score, band: bandFor(score), reason: reasonText };
}

module.exports = { scoreLead, bandFor };
