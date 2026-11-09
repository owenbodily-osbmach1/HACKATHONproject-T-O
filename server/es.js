// STUB (card C fills this in). Elasticsearch client over fetch. Every write is fire-and-forget:
// it must never throw into or delay the live caption/audio path. With no ELASTIC_URL it is a no-op.
// Interface: index(indexName, doc), search(indexName, body) -> hits[] (empty on any error), enabled -> bool.
module.exports = { enabled: false, index() {}, async search() { return []; } };
