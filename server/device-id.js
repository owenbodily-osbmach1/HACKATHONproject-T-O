// Device ids in Elasticsearch: never the phone's clientId itself, only a salted hash per scope.
// Votes and questions hash per talk ("talk:<talkId>"), booth check-ins per booth ("booth:<id>"), so
// distinct-device counts within a talk or a booth stay exact (the post-talk report, the k>=3 booth
// report), but one phone cannot be followed across talks or booths in the stored data.
// DEVICE_HASH_SECRET (or VISITOR_SECRET) keeps hashes stable across restarts; without either a
// random secret is used, so a device counted before and after a restart may count twice.
const crypto = require('crypto');

const SECRET = process.env.DEVICE_HASH_SECRET || process.env.VISITOR_SECRET || crypto.randomBytes(32).toString('hex');

function hashDevice(scope, clientId) {
  if (!clientId) return '';
  return crypto.createHmac('sha256', SECRET).update(`${scope}|${clientId}`).digest('hex').slice(0, 24);
}

module.exports = { hashDevice };
