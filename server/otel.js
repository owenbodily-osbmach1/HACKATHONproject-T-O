// STUB (card D fills this in). OpenTelemetry -> Dash0 over OTLP/HTTP. No endpoint set = no-op.
// Interface: start(), counter(name).add(n, attrs), span(name, fn).
const noop = { add() {} };
module.exports = { start() {}, counter() { return noop; }, span(name, fn) { return fn(); } };
