// Privacy page data (CONTRACT.md "Privacy"). Lists every Elasticsearch index Pulse writes
// and its fields, read live from GET /<index>/_mapping when ES is enabled; otherwise from
// scripts/es-setup.js so the page can never drift from the real mappings.
const fallback = require('../scripts/es-setup').mappings;

const INDICES = Object.keys(fallback);

function fieldType(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec.type === 'string') return spec.type;
  return 'object';
}

function staticFields(index) {
  return Object.entries(fallback[index] || {}).map(([field, spec]) => ({ field, type: fieldType(spec) }));
}

// GET /<index>/_mapping -> [{field, type}]. Null when the response has no properties.
async function liveFields(es, index) {
  const body = await es.raw('GET', `/${encodeURIComponent(index)}/_mapping`, undefined, 4000);
  const entry = body && (body[index] || Object.values(body)[0]);
  const props = entry && entry.mappings && entry.mappings.properties;
  if (!props || typeof props !== 'object') return null;
  const fields = Object.entries(props).map(([field, spec]) => ({ field, type: fieldType(spec) }));
  return fields.length ? fields : null;
}

async function indexList(es) {
  const enabled = Boolean(es && es.enabled);
  const indices = [];
  let live = 0;
  for (const index of INDICES) {
    let fields = null;
    if (enabled) {
      try { fields = await liveFields(es, index); } catch { fields = null; }
      if (fields) live += 1;
    }
    indices.push({ index, fields: fields || staticFields(index) });
  }
  const source = !enabled ? 'static' : live === INDICES.length ? 'elasticsearch' : 'mixed';
  return { source, enabled, indices };
}

function register(app, ctx) {
  app.get('/api/privacy', async (req, res) => {
    const { source, enabled, indices } = await indexList(ctx.es);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      source, // 'elasticsearch' (live mappings), 'mixed' (some index fell back) or 'static'
      elasticsearch: enabled,
      indices,
      privacy: {
        // Sign-in (server/signin.js): contact details in server memory only, never in these indices.
        personalData: require('./signin').enabled,
        signIn: {
          enabled: require('./signin').enabled,
          collects: ['first name', 'last name', 'company or occupation', 'email address'],
          storage: 'server memory only, cleared on restart',
          inElasticsearch: false,
          linkedToClientId: false,
          export: 'event team, staff key',
        },
        identifier: 'clientId', // random id generated on the phone
        clientIdRandom: true,
        clientIdGeneratedOnDevice: true,
        boothMinDevices: 3,
        keysLogged: false,
        keysTraced: false,
      },
    });
  });
}

module.exports = { register, _test: { fieldType, staticFields, INDICES } };
