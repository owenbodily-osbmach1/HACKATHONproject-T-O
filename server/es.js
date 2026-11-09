// Elasticsearch client over global fetch. Every write is fire-and-forget:
// it must never throw into or delay the live caption/audio path. With no ELASTIC_URL it is a no-op.
// Interface: index(indexName, doc, id?), updateByQuery(indexName, query, doc), search(indexName, body) -> hits[] (empty on any error), raw(method, path, body), enabled -> bool.
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
const pendingWrites = new Map();

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
  // Only the status and the Elasticsearch error type: the response body can echo document content
  // (captions, questions) into stdout and the OTel logs.
  const msg = err && err.message ? String(err.message) : String(err);
  const type = (msg.match(/"type"\s*:\s*"([a-z_]+)"/) || [])[1];
  const short = err && err.status ? `HTTP ${err.status}${type ? ` ${type}` : ''}` : (err && err.name === 'TimeoutError' ? 'timeout' : msg.split(' -> ')[0].slice(0, 80));
  log.warn(event, { index: index || null, error: short });
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

// Writes are non-blocking by default and always absorb Elasticsearch errors.
function index(name, doc, id) {
  if (!enabled) return;
  // Writes run embedding inference for semantic_text fields; a cold model can take several seconds.
  // Fire-and-forget, so a longer timeout never touches the live path (Radar investigation found 3 s too short).
  const write = () => raw(
    id == null ? 'POST' : 'PUT',
    id == null ? `/${name}/_doc` : `/${name}/_doc/${encodeURIComponent(String(id))}`,
    doc,
    15000
  );
  if (id == null) return write().catch((err) => warn('write', err, name));
  return queueWrite(`${name}:${id}`, name, write);
}

// Update every matching question document, including older documents with auto-generated _ids.
// Serialize by qid so a hide queued just after question creation cannot race the initial index write.
function updateByQuery(name, query, doc) {
  if (!enabled) return Promise.resolve();
  const qid = query && query.term && query.term.qid;
  const write = () => raw('POST', `/${name}/_update_by_query`, {
    query,
    script: { lang: 'painless', source: 'ctx._source.putAll(params.doc)', params: { doc } },
  }, 15000);
  if (qid == null) return write().catch((err) => warn('write', err, name));
  return queueWrite(`${name}:${qid}`, name, write);
}

// Partial update of one document by id. Unlike _update_by_query this does not depend on the
// index refresh, so a hide right after the question is created still lands.
function update(name, id, doc) {
  if (!enabled) return Promise.resolve();
  const write = () => raw('POST', `/${name}/_update/${encodeURIComponent(String(id))}`, { doc }, 15000);
  return queueWrite(`${name}:${id}`, name, write);
}

function queueWrite(key, name, write) {
  const previous = pendingWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(write).catch((err) => warn('write', err, name));
  pendingWrites.set(key, current);
  current.then(() => {
    if (pendingWrites.get(key) === current) pendingWrites.delete(key);
  });
  return current;
}

async function search(name, body) {
  if (!enabled) return [];
  try {
    const out = await raw('POST', `/${name}/_search`, body, 8000);
    return ((out && out.hits && out.hits.hits) || []).map((h) => h._source).filter(Boolean);
  } catch (err) {
    warn('search', err, name);
    return [];
  }
}

module.exports = { enabled, index, update, updateByQuery, search, raw };
