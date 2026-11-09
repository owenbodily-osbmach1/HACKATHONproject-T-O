// One JSON line per event on stdout, plus an OTel log record when telemetry is
// configured (otel.js). Synchronous, never awaited: safe on the live path.
// Privacy: callers pass counts and room/talk/ticket ids only. Never keys,
// caption text, question text or clientIds.
function emit(level, event, attrs) {
  const fields = attrs && typeof attrs === 'object' ? attrs : {};
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + '\n';
  } catch (_) {
    // A circular or non-serializable attr must not lose the event itself.
    line = JSON.stringify({ ts: new Date().toISOString(), level, event }) + '\n';
  }
  try { process.stdout.write(line); } catch (_) {}

  // Lazy require avoids an otel.js <-> log.js cycle at module load.
  try {
    const otel = require('./otel');
    if (typeof otel.emitLog === 'function') otel.emitLog(level, event, fields);
  } catch (_) {}
}

module.exports = {
  info: (event, attrs) => emit('info', event, attrs),
  warn: (event, attrs) => emit('warn', event, attrs),
  error: (event, attrs) => emit('error', event, attrs),
};
