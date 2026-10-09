// lib/oxylabs.js
//
// Oxylabs Web API client - the project's PRIMARY data-scrape source.
//
// Two endpoints on https://webapi.oxylabs.io:
//   POST /v1/search  -> ranked results (title, snippet, URL): find pages
//   POST /v1/scrape  -> the content of one page: read pages
// The core pattern is search -> scrape: search locates the answer, scrape
// reads it. Search snippets are truncated and often stale, never answer
// from them.
//
// Requires OXYLABS_WEB_API_KEY, read from the environment only. The key is
// never hardcoded, never logged and never included in an error message.
//
// Implements the integration checklist from
// https://developers.oxylabs.io/products/web-api/for-agents.md and the
// status/retry table from
// https://developers.oxylabs.io/products/web-api/troubleshooting.md:
//   - Authorization: Bearer header on every request
//   - ~120 s client timeout (a scrape renders a real page; 10 s fails work
//     that would have succeeded - and you still pay for it)
//   - success detected as any 2xx, never as a literal status like 201
//   - retries ONLY on transport timeouts and 408/429/5xx, exponential
//     backoff with jitter, max 3 attempts
//   - 400 surfaced with the failing field name, 401 with a clear message;
//     neither is ever retried
//   - max_results capped at 20, query capped at 2048 chars, location an
//     ISO 3166-1 alpha-2 country code
//   - metadata.request_id captured and logged so failures are reportable
//   - empty/skeletal scrape: retry once with run_js, and once more with
//     run_js + country location for country-TLD sites, then report the
//     page as unreadable (readPage below)

const API_BASE = 'https://webapi.oxylabs.io';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;           // "~3 attempts" per the checklist
const TIMEOUT_MS = 120000;        // ~120 s client timeout
const MAX_QUERY_LENGTH = 2048;    // query: 1-2048 characters
const MAX_RESULTS_CAP = 20;       // max_results: 1-20
const MIN_CONTENT_CHARS = 200;    // below this a scrape counts as skeletal

// Brand-use ccTLDs: skipped by the country-TLD re-scrape rule because the
// ending says nothing about the audience (.io, .ai, .co, .me per the docs;
// the rest are the same kind of brand-used ccTLD).
const BRAND_CCTLD = new Set(['io', 'ai', 'co', 'me', 'ly', 'tv', 'fm', 'gg', 'cc', 'ws']);

const OUTPUT_FORMATS = new Set(['markdown', 'html', 'json', 'screenshot']);

class OxylabsError extends Error {
  constructor(message, extras) {
    super(message);
    extras = extras || {};
    this.name = 'OxylabsError';
    this.status = extras.status !== undefined ? extras.status : null;
    this.title = extras.title !== undefined ? extras.title : null;
    this.requestId = extras.requestId || null;   // metadata.request_id
    this.attempts = extras.attempts !== undefined ? extras.attempts : null;
    this.retryable = !!extras.retryable;
  }
}

// 401 is a credential problem, never a request field: stop, tell the human.
class OxylabsAuthError extends OxylabsError {
  constructor(message, extras) {
    super(message, extras);
    this.name = 'OxylabsAuthError';
  }
}

function getKey() {
  const key = (process.env.OXYLABS_WEB_API_KEY || '').trim();
  if (!key) {
    throw new OxylabsError('OXYLABS_WEB_API_KEY is not set - ask the user for a key.');
  }
  return key;
}

function backoffMs(attempt, random) {
  // 2**attempt seconds + jitter, exactly as the docs' reference client.
  return Math.round((2 ** attempt + random()) * 1000);
}

function isTransportTimeout(err) {
  if (!err) return false;
  const code = err.code || '';
  return (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  );
}

// RFC 9457 problem body: branch on `title`, surface `errors[].pointer`.
function problemDetail(problem, fallbackText) {
  if (!problem || typeof problem !== 'object') return (fallbackText || '').slice(0, 300);
  const bits = [];
  if (problem.title) bits.push(problem.title);
  if (problem.detail) bits.push(problem.detail);
  if (Array.isArray(problem.errors)) {
    for (const e of problem.errors) {
      if (e && e.pointer) bits.push(`${e.pointer}: ${e.detail || ''}`.trim());
      else if (e && e.detail) bits.push(e.detail);
    }
  }
  return bits.join(' | ') || (fallbackText || '').slice(0, 300);
}

function requestIdOf(problem) {
  return (problem && problem.metadata && problem.metadata.request_id) || null;
}

// Only the request id is logged - never the key - so failures are still
// reportable to Oxylabs support via metadata.request_id.
function logRequestId(path, requestId, extra) {
  if (!requestId) return;
  console.log(`[oxylabs] ${path} request_id=${requestId}${extra ? ' ' + extra : ''}`);
}

// Core POST with retry: transport timeouts and 408/429/5xx only, exponential
// backoff with jitter, max 3 attempts. 400/401 never retried.
// opts: { fetch, sleep, random, timeoutMs, maxAttempts } for tests/overrides.
async function post(path, payload, opts) {
  opts = opts || {};
  const fetchImpl = opts.fetch || ((...args) => fetch(...args));
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random || Math.random;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const key = getKey();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetchImpl(`${API_BASE}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (isTransportTimeout(err)) {
        if (attempt === maxAttempts) {
          throw new OxylabsError(
            `${path} -> timed out after ${maxAttempts} attempts (client timeout ${timeoutMs} ms)`,
            { attempts: attempt, retryable: true }
          );
        }
        await sleep(backoffMs(attempt, random));
        continue;
      }
      throw new OxylabsError(
        `${path} -> transport error: ${(err && err.message) || String(err)}`,
        { attempts: attempt }
      );
    }

    // Success is ANY 2xx - never a literal comparison against one status.
    if (res.status >= 200 && res.status <= 299) {
      const body = await res.json().catch(() => null);
      const requestId = requestIdOf(body);
      logRequestId(path, requestId, `status=${res.status}`);
      return { body: body, status: res.status, requestId: requestId };
    }

    const text = await res.text().catch(() => '');
    let problem = null;
    try { problem = JSON.parse(text); } catch (e) { /* not a JSON problem body */ }
    const requestId = requestIdOf(problem);

    if (res.status === 401) {
      throw new OxylabsAuthError(
        '401 UNAUTHORIZED - the Oxylabs API key was rejected (missing, invalid, malformed, or revoked). Stop and tell the user; retrying cannot help.',
        { status: 401, attempts: attempt, requestId: requestId }
      );
    }

    const detail = problemDetail(problem, text);

    if (res.status === 400) {
      // Never retry unchanged - the message carries the failing field name.
      throw new OxylabsError(`${path} -> 400 ${detail}`, {
        status: 400,
        title: (problem && problem.title) || 'VALIDATION_ERROR',
        requestId: requestId,
        attempts: attempt,
        retryable: false,
      });
    }

    const retryable = RETRYABLE.has(res.status);
    if (!retryable || attempt === maxAttempts) {
      const hint = res.status === 429 && attempt === maxAttempts
        ? ' (rate limit or quota exhausted - lower concurrency; if 429 survives full backoff it is a quota problem for the user)'
        : '';
      throw new OxylabsError(`${path} -> ${res.status}: ${detail}${requestId ? ` (request_id=${requestId})` : ''}${hint}`, {
        status: res.status,
        title: (problem && problem.title) || null,
        requestId: requestId,
        attempts: attempt,
        retryable: retryable,
      });
    }
    logRequestId(path, requestId, `status=${res.status} -> retrying`);
    await sleep(backoffMs(attempt, random));
  }
  throw new OxylabsError(`${path} -> failed after ${maxAttempts} attempts`, { attempts: maxAttempts });
}

function normalizeLocation(location) {
  if (location === undefined || location === null || location === '') return null;
  const loc = String(location).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(loc)) {
    throw new OxylabsError(
      `location must be an ISO 3166-1 alpha-2 country code (e.g. "US", "DE"); got ${JSON.stringify(String(location))}.`
    );
  }
  return loc;
}

function validateUrl(url) {
  const raw = String(url === undefined || url === null ? '' : url);
  let parsed;
  try { parsed = new URL(raw); } catch (e) {
    throw new OxylabsError(`scrape: url must be an absolute http/https URL; got ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OxylabsError(`scrape: url must be http or https; got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

function normalizeOutput(output) {
  if (output === undefined || output === null) return ['markdown'];
  const list = Array.isArray(output) ? output : [output];
  if (list.length === 0) throw new OxylabsError('scrape: output must not be empty.');
  for (const fmt of list) {
    if (!OUTPUT_FORMATS.has(fmt)) {
      throw new OxylabsError(`scrape: unknown output format ${JSON.stringify(fmt)}; use markdown, html, json or screenshot.`);
    }
  }
  return list;
}

// POST /v1/search -> ranked results. Unknown fields are rejected by the API,
// so only query / max_results / location are ever sent.
async function search(query, opts) {
  opts = opts || {};
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 1) throw new OxylabsError('search: query is required (1-2048 characters).');
  if (q.length > MAX_QUERY_LENGTH) {
    throw new OxylabsError(
      `search: query is ${q.length} characters; the API limit is ${MAX_QUERY_LENGTH}. Shorten it - a 400 is never retried.`
    );
  }
  let maxResults = opts.maxResults === undefined ? 10 : opts.maxResults;
  if (!Number.isInteger(maxResults)) throw new OxylabsError('search: max_results must be an integer (1-20).');
  maxResults = Math.min(Math.max(maxResults, 1), MAX_RESULTS_CAP); // always <= 20
  const location = normalizeLocation(opts.location);

  const payload = { query: q, max_results: maxResults };
  if (location) payload.location = location;

  const out = await post('/v1/search', payload, opts);
  const body = out.body || {};
  return {
    state: body.state || null,
    results: Array.isArray(body.results) ? body.results : [],
    relatedSearches: Array.isArray(body.related_searches) ? body.related_searches : [],
    params: body.params || null,
    requestId: out.requestId,
  };
}

// POST /v1/scrape -> one page in the requested format (markdown by default;
// ask for html only when the markup itself is needed).
async function scrape(url, opts) {
  opts = opts || {};
  const target = validateUrl(url);
  const output = normalizeOutput(opts.output);
  const location = normalizeLocation(opts.location);
  const device = opts.device === undefined || opts.device === null ? null : opts.device;
  if (device !== null && device !== 'desktop' && device !== 'mobile') {
    throw new OxylabsError('scrape: device must be "desktop" or "mobile".');
  }
  if (output.indexOf('screenshot') !== -1 && !opts.runJs) {
    throw new OxylabsError('scrape: output "screenshot" requires run_js: true (otherwise the API rejects the request).');
  }

  const payload = { url: target, output: output };
  if (opts.runJs) payload.run_js = true;      // default false - never render JS by default
  if (location) payload.location = location;
  if (device) payload.device = device;

  const out = await post('/v1/scrape', payload, opts);
  const body = out.body || {};
  return {
    state: body.state || null,
    results: Array.isArray(body.results) ? body.results : [],
    params: body.params || null,
    requestId: out.requestId,
  };
}

function pageContent(results) {
  const first = (Array.isArray(results) && results[0]) || null;
  if (!first) return { content: '', finalUrl: null, title: null };
  const content = typeof first.markdown === 'string' ? first.markdown : '';
  const finalUrl = (first.metadata && first.metadata.url) || first.url || null;
  const title = typeof first.title === 'string' ? first.title : null;
  return { content: content, finalUrl: finalUrl, title: title };
}

// Country code for the country-TLD re-scrape rule: .lt -> LT, .es -> ES,
// .co.uk -> GB. Brand-use ccTLDs (.io, .ai, .co, .me, ...) are skipped:
// they say nothing about the audience. Returns null when not applicable.
function countryCodeFromUrl(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (e) { return null; }
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2}$/.test(tld)) return null;    // not a ccTLD (.com, .org, ...)
  if (BRAND_CCTLD.has(tld)) return null;       // brand-use ccTLD: skip
  if (tld === 'uk') return 'GB';               // .co.uk and friends -> GB
  return tld.toUpperCase();
}

// The reader: scrape with the documented retry ladder for empty pages.
//   1. plain markdown read
//   2. still empty/skeletal -> retry once with run_js: true
//   3. still empty AND a country TLD -> retry once more with run_js: true
//      plus location for that country
//   4. still empty -> report the page as unreadable (never guess content).
// API/auth errors are never swallowed: they propagate so failures are
// reported out loud.
async function readPage(url, opts) {
  opts = opts || {};
  const minChars = opts.minContentChars || MIN_CONTENT_CHARS;
  const country = countryCodeFromUrl(url);
  const attempts = [];
  const requestIds = [];

  const runAttempt = async (label, attemptOpts) => {
    const res = await scrape(url, Object.assign({}, opts, attemptOpts));
    attempts.push(label);
    if (res.requestId) requestIds.push(res.requestId);
    const got = pageContent(res.results);
    return {
      content: (got.content || '').trim(),
      raw: got.content || '',
      finalUrl: got.finalUrl,
      title: got.title,
    };
  };

  const ok = (got, passedUrl) => ({
    url: got.finalUrl || passedUrl,
    title: got.title,
    content: got.raw,
    unreadable: false,
    attempts: attempts.slice(),
    requestIds: requestIds.slice(),
  });

  // Attempt 1: plain read (never render JS by default - a render is slow).
  let got = await runAttempt('plain', {});
  if (got.content.length >= minChars) return ok(got, url);

  // Attempt 2: empty or skeletal -> run_js: true (client-side rendering).
  got = await runAttempt('run_js', { runJs: true });
  if (got.content.length >= minChars) return ok(got, url);

  // Attempt 3: still empty and a country TLD -> run_js + that location.
  if (country) {
    got = await runAttempt('run_js+location:' + country, { runJs: true, location: country });
    if (got.content.length >= minChars) return ok(got, url);
  }

  return {
    url: url,
    title: got.title || null,
    content: '',
    unreadable: true,
    reason:
      `empty or skeletal after ${attempts.length} attempt(s): ${attempts.join(', ')}. ` +
      (country
        ? `Country retry (location=${country}) also returned nothing.`
        : 'Site is not on a usable country TLD, so no localized retry applies.') +
      ' The page is unreadable.',
    attempts: attempts,
    requestIds: requestIds.slice(),
    minContentChars: minChars,
  };
}

module.exports = {
  search,
  scrape,
  readPage,
  OxylabsError,
  OxylabsAuthError,
  hasOxylabsKey: () => !!(process.env.OXYLABS_WEB_API_KEY || '').trim(),
  countryCodeFromUrl,
  API_BASE,
  RETRYABLE,
  MAX_ATTEMPTS,
  TIMEOUT_MS,
};
