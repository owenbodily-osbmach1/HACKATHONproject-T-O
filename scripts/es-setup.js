// Create Pulse's Elasticsearch indices (CONTRACT.md "Elasticsearch indices").
// Idempotent: an index that already exists is left untouched.
// Run: node --env-file=.env scripts/es-setup.js
const config = require('../server/config');
const es = require('../server/es');

// semantic_text without inference_id uses the cluster default endpoint.
function semantic() {
  return config.ES_INFERENCE_ID
    ? { type: 'semantic_text', inference_id: config.ES_INFERENCE_ID }
    : { type: 'semantic_text' };
}

const sem = semantic();
const mappings = {
  'pulse-captions': {
    talkId: { type: 'keyword' },
    room: { type: 'keyword' },
    seq: { type: 'integer' },
    text: { type: 'text', copy_to: 'text_sem' },
    text_sem: sem,
    ts: { type: 'date' },
    minute: { type: 'integer' },
  },
  'pulse-signals': {
    talkId: { type: 'keyword' },
    room: { type: 'keyword' },
    type: { type: 'keyword' },
    clientId: { type: 'keyword' },
    on: { type: 'boolean' },
    ts: { type: 'date' },
    minute: { type: 'integer' },
  },
  'pulse-questions': {
    qid: { type: 'keyword' },
    talkId: { type: 'keyword' },
    room: { type: 'keyword' },
    text: { type: 'text', copy_to: 'text_sem' },
    text_sem: sem,
    clientId: { type: 'keyword' },
    ts: { type: 'date' },
    groupId: { type: 'keyword' },
    answered: { type: 'boolean' },
    answeredSeq: { type: 'integer' },
  },
  'pulse-tickets': {
    id: { type: 'keyword' },
    room: { type: 'keyword' },
    talkId: { type: 'keyword' },
    type: { type: 'keyword' },
    status: { type: 'keyword' },
    people: { type: 'integer' },
    openedAt: { type: 'date' },
    ackAt: { type: 'date' },
    fixedAt: { type: 'date' },
    better: { type: 'integer' },
    stillBad: { type: 'integer' },
  },
  'pulse-talks': {
    talkId: { type: 'keyword' },
    title: { type: 'text', copy_to: 'title_sem' },
    title_sem: sem,
    abstract: { type: 'text' },
    track: { type: 'keyword' },
    room: { type: 'keyword' },
    start: { type: 'date' },
    end: { type: 'date' },
    speakers: { type: 'keyword' },
  },
  'pulse-actions': {
    room: { type: 'keyword' },
    talkId: { type: 'keyword' },
    actor: { type: 'keyword' },
    action: { type: 'keyword' },
    detail: { type: 'text' },
    ts: { type: 'date' },
  },
};

async function main() {
  if (!es.enabled) {
    console.error('ELASTIC_URL and ELASTIC_API_KEY are required');
    process.exitCode = 1;
    return;
  }
  for (const [name, properties] of Object.entries(mappings)) {
    try {
      await es.raw('HEAD', `/${name}`);
      console.log(`${name}: exists`);
      continue;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await es.raw('PUT', `/${name}`, { mappings: { properties } });
    console.log(`${name}: created`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { main, mappings };
