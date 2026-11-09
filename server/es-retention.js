// Retention for Elasticsearch documents that carry a device id (hashed, see device-id.js):
// pulse-signals, pulse-questions and pulse-checkins keep RETENTION_DAYS days (default 30, 0 = keep).
// Elastic Cloud Serverless has no classic ILM for plain indices, so this is a delete-by-age job:
// once an hour after start, then every 6 h, plus `node scripts/es-setup.js --retention` by hand.
// Fire-and-forget like every other Elasticsearch call: it never touches the live path.
const log = require('./log');

const INDICES = ['pulse-signals', 'pulse-questions', 'pulse-checkins'];
const DAYS = Math.max(0, Number(process.env.RETENTION_DAYS ?? 30));

function retentionQuery(days) {
  return { query: { range: { ts: { lt: `now-${Math.floor(days)}d` } } } };
}

async function runRetention(es, days = DAYS) {
  if (!es || !es.enabled || !days) return { deleted: 0, skipped: true };
  const path = `/${INDICES.join(',')}/_delete_by_query?conflicts=proceed&ignore_unavailable=true&allow_no_indices=true`;
  const res = await es.raw('POST', path, retentionQuery(days), 60000);
  const deleted = Number(res && res.deleted) || 0;
  log.info('es.retention', { days, deleted });
  return { deleted };
}

module.exports = {
  INDICES,
  DAYS,
  retentionQuery,
  runRetention,
  register(app, ctx) {
    if (!ctx.es || !ctx.es.enabled || !DAYS) return;
    const run = () => runRetention(ctx.es).catch((err) => log.warn('es.retention_failed', { error: err && err.status ? `HTTP ${err.status}` : 'error' }));
    const first = setTimeout(run, 60 * 60 * 1000);
    const every = setInterval(run, 6 * 60 * 60 * 1000);
    if (first.unref) first.unref();
    if (every.unref) every.unref();
  },
};
