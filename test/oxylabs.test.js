// test/oxylabs.test.js
//
// Unit tests for lib/oxylabs.js against a MOCKED transport - no real HTTP
// calls and no real key. The dummy key below is deliberately fake: if an
// assertion ever prints it, nothing secret leaks (integration checklist:
// "tests set a dummy key of their own").
const test = require('node:test');
const assert = require('node:assert/strict');

const DUMMY_KEY = 'dummy-test-key-000000';
process.env.OXYLABS_WEB_API_KEY = DUMMY_KEY;

const {
  search,
  readPage,
  OxylabsError,
  OxylabsAuthError,
  countryCodeFromUrl,
} = require('../lib/oxylabs.js');

// ---- mocked transport -------------------------------------------------

function res200(body) {
  return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function resErr(status, body) {
  return { status: status, json: async () => body, text: async () => JSON.stringify(body) };
}
function queue(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: url, init: init, body: init && init.body ? JSON.parse(init.body) : null });
    if (responses.length === 0) throw new Error('mocked transport exhausted');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
function recorder(sleeps) {
  return async (ms) => { sleeps.push(ms); };
}
const constRandom = () => 0.5; // backoff = 2**attempt + 0.5 seconds

function searchBody(requestId) {
  return {
    state: 'done',
    results: [{ title: 'T', outline: 'o', url: 'https://example.com/a', metadata: { position: 1 } }],
    related_questions: [],
    related_searches: [],
    params: {},
    metadata: { timestamp: 1, request_id: requestId },
  };
}
function scrapeBody(requestId, markdown, url) {
  return {
    state: 'done',
    results: [{ markdown: markdown, metadata: { url: url || 'https://example.com/a' } }],
    params: {},
    metadata: { timestamp: 1, request_id: requestId },
  };
}

// ---- error mapping + retry -------------------------------------------

test('retries 5xx with exponential backoff + jitter, succeeds on attempt 3', async () => {
  const sleeps = [];
  const fetch = queue(
    resErr(503, { title: 'SERVICE_UNAVAILABLE', detail: 'temporarily unavailable', metadata: { request_id: 'rid-503' } }),
    resErr(500, { title: 'INTERNAL_ERROR', detail: 'unexpected fault', metadata: { request_id: 'rid-500' } }),
    res200(searchBody('rid-ok')),
  );
  const out = await search('test query', { fetch, sleep: recorder(sleeps), random: constRandom });
  assert.equal(out.requestId, 'rid-ok');
  assert.equal(out.results.length, 1);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [2500, 4500]); // (2**1 + 0.5)s, (2**2 + 0.5)s
});

test('400 is surfaced with the failing field name and never retried', async () => {
  const sleeps = [];
  const fetch = queue(resErr(400, {
    status: 400,
    title: 'VALIDATION_ERROR',
    detail: '1 request field is invalid; fix every entry in `errors` and resend.',
    metadata: { request_id: 'rid-400' },
    errors: [{ pointer: '#/max_results', detail: 'Input should be less than or equal to 20' }],
  }));
  await assert.rejects(
    () => search('q', { fetch, sleep: recorder(sleeps), random: constRandom }),
    (err) => {
      assert.ok(err instanceof OxylabsError);
      assert.ok(!(err instanceof OxylabsAuthError), '400 must not be an auth error');
      assert.equal(err.status, 400);
      assert.match(err.message, /#\/max_results/);
      assert.match(err.message, /Input should be less than or equal to 20/);
      assert.equal(err.requestId, 'rid-400');
      return true;
    },
  );
  assert.equal(fetch.calls.length, 1, '400 must not be retried');
  assert.deepEqual(sleeps, [], '400 must not back off');
});

test('401 raises OxylabsAuthError, is not retried, and never leaks the key', async () => {
  const sleeps = [];
  const fetch = queue({ status: 401, json: async () => { throw new Error('no body'); }, text: async () => '' });
  await assert.rejects(
    () => search('q', { fetch, sleep: recorder(sleeps), random: constRandom }),
    (err) => {
      assert.ok(err instanceof OxylabsAuthError);
      assert.equal(err.status, 401);
      assert.match(err.message, /401/);
      assert.match(err.message, /key was rejected/);
      assert.ok(!err.message.includes(DUMMY_KEY), 'error message must never contain the key');
      return true;
    },
  );
  assert.equal(fetch.calls.length, 1, '401 must not be retried');
  assert.deepEqual(sleeps, [], '401 must not back off');
});

test('transport timeouts are retried with backoff, capped at 3 attempts', async () => {
  const sleeps = [];
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const fetch = queue(abortErr, abortErr, abortErr);
  await assert.rejects(
    () => search('q', { fetch, sleep: recorder(sleeps), random: constRandom }),
    (err) => {
      assert.ok(err instanceof OxylabsError);
      assert.match(err.message, /timed out after 3 attempts/);
      assert.equal(err.attempts, 3);
      return true;
    },
  );
  assert.equal(fetch.calls.length, 3, 'timeout must be retried up to 3 attempts');
  assert.deepEqual(sleeps, [2500, 4500]);
});

test('non-retryable statuses (404) fail immediately without backoff', async () => {
  const sleeps = [];
  const fetch = queue(resErr(404, { title: 'NOT_FOUND', detail: 'no such path', metadata: { request_id: 'rid-404' } }));
  await assert.rejects(
    () => search('q', { fetch, sleep: recorder(sleeps), random: constRandom }),
    (err) => {
      assert.ok(err instanceof OxylabsError);
      assert.equal(err.status, 404);
      assert.equal(err.requestId, 'rid-404');
      return true;
    },
  );
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

// ---- empty-scrape retry ladder (run_js / country TLD) ------------------

test('empty scrape: retry with run_js, then run_js + country location, then report unreadable', async () => {
  const fetch = queue(
    res200(scrapeBody('rid-1', '')),
    res200(scrapeBody('rid-2', '')),
    res200(scrapeBody('rid-3', '')),
  );
  const out = await readPage('https://example.es/news/item', { fetch, sleep: noSleep, random: constRandom });
  assert.equal(out.unreadable, true, 'three empty attempts must be reported unreadable');
  assert.deepEqual(out.attempts, ['plain', 'run_js', 'run_js+location:ES']);
  assert.deepEqual(out.requestIds, ['rid-1', 'rid-2', 'rid-3']);
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[0].body.run_js, undefined, 'first attempt must not render JS by default');
  assert.equal(fetch.calls[1].body.run_js, true, 'second attempt must retry with run_js: true');
  assert.equal(fetch.calls[2].body.run_js, true, 'third attempt must keep run_js: true');
  assert.equal(fetch.calls[2].body.location, 'ES', 'third attempt must set location for the country TLD');
  assert.match(out.reason, /unreadable/);
});

test('empty scrape on a brand-use ccTLD (.io) gets no country retry', async () => {
  const fetch = queue(
    res200(scrapeBody('rid-io-1', '')),
    res200(scrapeBody('rid-io-2', '')),
  );
  const out = await readPage('https://startup.io/pricing', { fetch, sleep: noSleep, random: constRandom });
  assert.equal(out.unreadable, true);
  assert.deepEqual(out.attempts, ['plain', 'run_js']);
  assert.equal(fetch.calls.length, 2, '.io must stop after the run_js retry - no location attempt');
  assert.equal(fetch.calls[1].body.location, undefined);
});

test('a skeletal page recovers on the run_js retry', async () => {
  const fetch = queue(
    res200(scrapeBody('rid-skel', '#\n')),
    res200(scrapeBody('rid-rendered', '# Real page\n\n' + 'Substantial content. '.repeat(20))),
  );
  const out = await readPage('https://app.com/spa', { fetch, sleep: noSleep, random: constRandom });
  assert.equal(out.unreadable, false);
  assert.deepEqual(out.attempts, ['plain', 'run_js']);
  assert.equal(out.requestId, undefined, 'reader exposes requestIds, not a singular id');
  assert.deepEqual(out.requestIds, ['rid-skel', 'rid-rendered']);
  assert.match(out.content, /Real page/);
  assert.equal(fetch.calls.length, 2);
});

test('a country-TLD page that renders on attempt 3 is returned, not unreadable', async () => {
  const long = 'Contenido suficiente. '.repeat(30);
  const fetch = queue(
    res200(scrapeBody('rid-lt-1', '')),
    res200(scrapeBody('rid-lt-2', '')),
    res200(scrapeBody('rid-lt-3', long, 'https://parduotuve.lt/vienas')),
  );
  const out = await readPage('https://parduotuve.lt/vienas', { fetch, sleep: noSleep, random: constRandom });
  assert.equal(out.unreadable, false);
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].body.location, 'LT');
  assert.deepEqual(out.requestIds, ['rid-lt-1', 'rid-lt-2', 'rid-lt-3']);
});

// ---- request shaping + auth header ------------------------------------

test('search caps max_results at 20, normalizes location, sends no unknown fields', async () => {
  const fetch = queue(res200(searchBody('rid-cap')));
  const out = await search('q', { maxResults: 99, location: 'de', fetch, sleep: noSleep });
  assert.equal(out.requestId, 'rid-cap');
  assert.equal(fetch.calls[0].body.max_results, 20, 'max_results must be capped at <= 20');
  assert.equal(fetch.calls[0].body.location, 'DE', 'location must be ISO 3166-1 alpha-2, uppercased');
  assert.deepEqual(
    Object.keys(fetch.calls[0].body).sort(),
    ['location', 'max_results', 'query'],
    'unknown fields are rejected by the API - never send them',
  );
});

test('query over 2048 characters and bad locations are rejected before any request', async () => {
  const fetch = queue();
  await assert.rejects(() => search('x'.repeat(2049), { fetch, sleep: noSleep }), /2048/);
  await assert.rejects(() => search('q', { location: 'USA', fetch, sleep: noSleep }), /ISO 3166-1 alpha-2/);
  assert.equal(fetch.calls.length, 0, 'invalid input must not reach the network');
});

test('every request carries Authorization: Bearer, and any 2xx counts as success', async () => {
  const fetch = queue({ status: 202, json: async () => searchBody('rid-202'), text: async () => '' });
  const out = await search('q', { fetch, sleep: noSleep });
  assert.equal(out.requestId, 'rid-202', '202 must be treated as success (any 2xx, not a literal status)');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer ' + DUMMY_KEY);
  assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(fetch.calls[0].url, 'https://webapi.oxylabs.io/v1/search');
});

test('countryCodeFromUrl maps country TLDs per the docs and skips brand ccTLDs', () => {
  assert.equal(countryCodeFromUrl('https://a.lt/x'), 'LT');
  assert.equal(countryCodeFromUrl('https://shop.es/x'), 'ES');
  assert.equal(countryCodeFromUrl('https://www.example.co.uk/x'), 'GB');
  assert.equal(countryCodeFromUrl('https://a.io/x'), null, '.io is brand-use, not a country signal');
  assert.equal(countryCodeFromUrl('https://a.ai/x'), null);
  assert.equal(countryCodeFromUrl('https://a.co/x'), null);
  assert.equal(countryCodeFromUrl('https://a.me/x'), null);
  assert.equal(countryCodeFromUrl('https://a.com/x'), null, '.com is not a ccTLD');
  assert.equal(countryCodeFromUrl('not a url'), null);
});
