// Elasticsearch client over global fetch. Every write is fire-and-forget:
// it must never throw into or delay the live caption/audio path. With no ELASTIC_URL it is a no-op.
// Interface: index(indexName, doc), search(indexName, body) -> hits[] (empty on any error), raw(method, path, body), enabled -> bool.
const config = require('./config');
const log = require('./log');

const enabled = Boolean(config.ELASTIC_URL && config.ELASTIC_API_KEY);
const base = (config.ELASTIC_URL || '').replace(/\/+$/, '');
const headers = {
  'Content-Type': 'application/json',
  Authorization: 'ApiKey ' + config.ELASTIC_API_KEY,
};

let lastWriteWarn = 0;
let lastSearchWarn = 0;

function warnOnce(slot) {
  const now = Date.now();
  const last = slot === 'write' ? lastWriteWarn : lastSearchWarn;
  if (now - last < 60_000) return false;
  if (slot === 'write') lastWriteWarn = now;
  else lastSearchWarn = now;
  return true;
}

function warn(slot, err, index) {
  if (!warnOnce(slot)) return; // at most one line per minute per path
  const event = slot === 'write' ? 'es.write_failed' : 'es.search_failed';
  log.warn(event, { index: index || null, error: err && err.message ? err.message : String(err) });
}

// Raw request: throws on any HTTP or network failure. Only es-setup and the search
// retriever path use this; live writes go through index().
async function raw(method, path, body, timeoutMs = 3000) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`es ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// Fire-and-forget write. Never throws, never awaited.
function index(name, doc) {
  if (!enabled) return;
  // Writes run ELSER inference for semantic_text fields; a cold model can take several seconds.
  // Fire-and-forget, so a longer timeout never touches the live path (Radar investigation found 3 s too short).
  raw('POST', `/${name}/_doc`, doc, 15000).catch((err) => warn('write', err, name));
}

async function search(name, body) {
  if (!enabled) return [];
  try {
    const out = await raw('POST', `/${name}/_search`, body);
    return ((out && out.hits && out.hits.hits) || []).map((h) => h._source).filter(Boolean);
  } catch (err) {
    warn('search', err, name);
    return [];
  }
}

module.exports = { enabled, index, search, raw };
