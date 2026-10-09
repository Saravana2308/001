// api/web-scrape.js
//
// POST - the project's PRIMARY data-scrape route: one live web search via
// the Oxylabs Web API, then read the top result pages (the documented
// search -> scrape pattern). Search snippets are truncated and often stale,
// so nothing is ever answered from them - the pages are actually read.
//
// Body:    { "query": "...", "maxResults": 5, "location": "DE" }
// Returns: { requestId, state, results: [{ url, title, content | error }] }
//
// Requires OXYLABS_WEB_API_KEY (see lib/oxylabs.js). Failures are reported
// out loud per page - a dead URL is a fact to report, not something to hide.

const { search, readPage } = require('../lib/oxylabs');

const READ_TOP = 3; // search once, then read the 1-3 pages that plausibly answer it

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return res.status(400).json({ error: 'query is required - describe what you want to find on the live web.' });
  }
  const parsedMax = body.maxResults === undefined || body.maxResults === null ? 5 : parseInt(body.maxResults, 10);
  const maxResults = Number.isFinite(parsedMax) ? parsedMax : 5;
  const location = body.location === undefined || body.location === null || body.location === ''
    ? undefined
    : body.location;

  try {
    const found = await search(query, { maxResults: maxResults, location: location });

    // Sequential on purpose: scraping many pages in parallel multiplies cost
    // and latency for pages that may never be read.
    const pages = [];
    for (const hit of found.results.slice(0, READ_TOP)) {
      try {
        const page = await readPage(hit.url, { location: location });
        pages.push({
          url: page.url,
          title: hit.title || page.title || '',
          unreadable: page.unreadable,
          attempts: page.attempts,
          requestIds: page.requestIds,
          content: page.unreadable ? undefined : page.content,
          // An unreadable page is a result too - say so instead of hiding it.
          error: page.unreadable ? page.reason : undefined,
        });
      } catch (err) {
        if (err && err.name === 'OxylabsAuthError') throw err; // stop - retrying cannot help
        pages.push({ url: hit.url, title: hit.title || '', error: (err && err.message) || String(err) });
      }
    }

    return res.status(200).json({
      requestId: found.requestId,
      state: found.state,
      results: pages,
      note: found.results.length === 0
        ? 'The search matched nothing - an empty results array on a 200 just means no page matched the query.'
        : undefined,
    });
  } catch (err) {
    if (err && err.name === 'OxylabsAuthError') {
      // Oxylabs rejected the key: surface it clearly, never retry-worthy.
      return res.status(401).json({ error: err.message });
    }
    if (err && err.name === 'OxylabsError') {
      // Validation messages from the client itself (search:/scrape:) are 400s;
      // upstream statuses pass through; anything else is an upstream failure.
      const isValidation = !err.status && /^(search|scrape):/.test(err.message);
      const status = isValidation
        ? 400
        : (Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502);
      return res.status(status).json({ error: err.message, requestId: err.requestId || undefined });
    }
    console.error('[oxylabs] web-scrape failed:', (err && err.message) || err);
    return res.status(500).json({ error: "The web scrape failed. Please try again." });
  }
};
