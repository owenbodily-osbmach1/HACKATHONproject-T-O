// OpenTelemetry -> Dash0 over OTLP/HTTP. No endpoint set = no-op.
// Helpers: counter(name, desc, unit), histogram(name, desc, unit),
// observableGauge(name, desc, cb, unit), span(name, attrs, fn), emitLog(level, event, attrs), snapshot(room).
// Exporters read OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS themselves, so Dash0 auth
// (Authorization=Bearer ...) stays in the environment and is never logged here.
//
// Every counter, histogram and gauge is also mirrored into a small in-process registry (with or
// without an endpoint) so the AV console can show the series this pod exports: GET /api/metrics.
// Recording is O(1) and bounded: 60 one-second buckets per counter, the last 256 samples per
// histogram, at most MAX_LABELS distinct pulse.room values per series.
const api = require('@opentelemetry/api');
const config = require('./config');

const SERVICE_NAME = config.OTEL_SERVICE_NAME;
const SERVICE_VERSION = process.env.APP_VERSION || 'dev';
const DEPLOYMENT_ENVIRONMENT = process.env.DEPLOY_ENV || 'hackathon';

const noopCounter = { add() {} };
const noopHistogram = { record() {} };

const SEVERITY = { info: api.SeverityNumber.INFO, warn: api.SeverityNumber.WARN, error: api.SeverityNumber.ERROR };

let started = false;
let startFailed = false;
let tracer = null;
let meter = null;
let logger = null;

const MAX_LABELS = 64;
const OTHER = '*';
const RATE_SECS = 60;
const WINDOW = 256;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_GAUGE_POINTS = 256;

const series = new Map(); // name -> {name, kind, unit, description, entries | cb}
const GAUGE_UNITS = { 'pulse.listeners': '{socket}', 'pulse.rooms.alerting': '{room}' };

const exportState = {
  metrics: { at: 0, ok: null, failures: 0 },
  traces: { at: 0, ok: null, failures: 0 },
};

function watchExport(exporter, slot) {
  try {
    if (!exporter || typeof exporter.export !== 'function') return;
    const original = exporter.export.bind(exporter);
    const state = exportState[slot];
    exporter.export = (items, done) => {
      state.at = Date.now();
      if (typeof done !== 'function') return original(items, done);
      return original(items, (result) => {
        try {
          state.ok = Boolean(result) && result.code === 0;
          if (!state.ok) state.failures += 1;
        } catch (_) {}
        done(result);
      });
    };
  } catch (_) {}
}

function start() {
  if (started || !config.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  started = true;
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
    const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const { defaultResource, resourceFromAttributes } = require('@opentelemetry/resources');

    // Resource semconv: service.name, service.version, deployment.environment.name.
    const resource = defaultResource().merge(
      resourceFromAttributes({
        'service.name': SERVICE_NAME,
        'service.version': SERVICE_VERSION,
        'deployment.environment.name': DEPLOYMENT_ENVIRONMENT,
      })
    );

    const { scrubbingExporter } = require('./telemetry-scrub');
    const traceExporter = new OTLPTraceExporter();
    const metricExporter = new OTLPMetricExporter();
    watchExport(traceExporter, 'traces');
    watchExport(metricExporter, 'metrics');

    const sdk = new NodeSDK({
      serviceName: SERVICE_NAME,
      resource,
      // No host / process / OS detectors: they would send the machine name, OS user and command line.
      autoDetectResources: false,
      // Every span is scrubbed before export: no client IP, user agent or query string (telemetry-scrub.js).
      traceExporter: scrubbingExporter(traceExporter),
      // NodeSDK registers this provider with the global logs API, so log.js
      // emits through the same resource and batch pipeline as traces/metrics.
      logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 10000,
        }),
      ],
      // Keyed pages/sockets carry ?key= in the URL; HttpInstrumentation would export it as url.query (security audit).
      instrumentations: [new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /[?&]key=/i.test(req.url || '') }), new ExpressInstrumentation()],
    });
    sdk.start();
    // index.js loads http and express before otel.start(); re-requiring the
    // cached modules lets the instrumentation hooks patch them (the app and
    // server objects do not exist yet).
    require('http');
    require('express');

    tracer = api.trace.getTracer(SERVICE_NAME);
    meter = api.metrics.getMeter(SERVICE_NAME);
    logger = api.logs.getLogger(SERVICE_NAME);
  } catch (err) {
    // Telemetry is best-effort: a bad exporter config must never stop the app.
    tracer = null;
    meter = null;
    logger = null;
    startFailed = true;
    // Lazy require: log.js reads emitLog from this module.
    try { require('./log').warn('otel.disabled', { error: err.message }); } catch (_) {}
  }
}

// ---------- in-process mirror ----------

function seriesFor(name, kind, description, unit) {
  let s = series.get(name);
  if (s && s.kind === kind) {
    if (!s.description && description) s.description = description;
    if (!s.unit && unit) s.unit = unit;
    return s;
  }
  s = { name, kind, description: description || '', unit: unit || '', entries: new Map(), cb: null };
  series.set(name, s);
  return s;
}

function labelOf(attributes) {
  const room = attributes ? attributes['pulse.room'] : undefined;
  if (room === undefined || room === null) return '';
  const label = String(room);
  return label.length > 64 ? label.slice(0, 64) : label;
}

function newEntry(kind) {
  const e = { sec: 0, buckets: new Float64Array(RATE_SECS), total: 0, count: 0, sum: 0, n: 0, vals: null, at: null };
  if (kind === 'histogram') {
    e.vals = new Float64Array(WINDOW);
    e.at = new Float64Array(WINDOW);
  }
  return e;
}

function entryFor(s, attributes) {
  let label = labelOf(attributes);
  let e = s.entries.get(label);
  if (e) return e;
  if (s.entries.size >= MAX_LABELS) {
    label = OTHER;
    e = s.entries.get(label);
    if (e) return e;
  }
  e = newEntry(s.kind);
  s.entries.set(label, e);
  return e;
}

function advance(e, sec) {
  if (sec === e.sec) return;
  const gap = sec - e.sec;
  if (e.sec === 0 || gap >= RATE_SECS || gap < 0) e.buckets.fill(0);
  else for (let i = 1; i <= gap; i++) e.buckets[(e.sec + i) % RATE_SECS] = 0;
  e.sec = sec;
}

function mirrorAdd(s, value, attributes) {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const e = entryFor(s, attributes);
    advance(e, sec);
    e.buckets[sec % RATE_SECS] += value;
    e.total += value;
  } catch (_) {}
}

function mirrorRecord(s, value, attributes) {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const e = entryFor(s, attributes);
    advance(e, sec);
    e.buckets[sec % RATE_SECS] += 1;
    const i = e.n % WINDOW;
    e.vals[i] = value;
    e.at[i] = now;
    e.n += 1;
    e.count += 1;
    e.sum += value;
  } catch (_) {}
}

function counter(name, description, unit) {
  const s = seriesFor(name, 'counter', description, unit);
  let inner = noopCounter;
  if (meter) {
    try {
      inner = meter.createCounter(name, { description, unit });
    } catch (_) {}
  }
  return {
    add(value, attributes, context) {
      try { inner.add(value, attributes, context); } catch (_) {}
      mirrorAdd(s, value, attributes);
    },
  };
}

function histogram(name, description, unit, advice) {
  const s = seriesFor(name, 'histogram', description, unit);
  let inner = noopHistogram;
  if (meter) {
    try {
      inner = meter.createHistogram(name, advice ? { description, unit, advice } : { description, unit });
    } catch (_) {}
  }
  return {
    record(value, attributes, context) {
      try { inner.record(value, attributes, context); } catch (_) {}
      mirrorRecord(s, value, attributes);
    },
  };
}

// cb returns either a number or [{ value, attributes }]; each point is observed
// on every export attempt. Telemetry callbacks never throw into the SDK.
// This API version registers async callbacks with addCallback, not createObservableGauge.
function observableGauge(name, description, cb, unit) {
  const s = seriesFor(name, 'gauge', description, unit || GAUGE_UNITS[name]);
  s.cb = typeof cb === 'function' ? cb : null;
  if (!meter) return;
  try {
    const opts = unit ? { description, unit } : { description };
    const gauge = meter.createObservableGauge(name, opts);
    gauge.addCallback((observer) => {
      try {
        const out = cb();
        if (Array.isArray(out)) {
          for (const point of out) {
            if (point && typeof point.value === 'number') observer.observe(point.value, point.attributes);
          }
        } else if (typeof out === 'number') {
          observer.observe(out);
        }
      } catch (_) {}
    });
  } catch (_) {}
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function rateOf(entries, sec) {
  let sum = 0;
  for (const e of entries) {
    advance(e, sec);
    for (let i = 0; i < RATE_SECS; i++) sum += e.buckets[i];
  }
  return sum / Math.min(RATE_SECS, Math.max(1, process.uptime()));
}

function recent(entries, now) {
  const out = [];
  const since = now - WINDOW_MS;
  for (const e of entries) {
    const len = Math.min(e.n, WINDOW);
    for (let i = 0; i < len; i++) if (e.at[i] >= since) out.push(e.vals[i]);
  }
  return out.length ? Float64Array.from(out).sort() : [];
}

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

function summarize(s, entries, now) {
  const sec = Math.floor(now / 1000);
  if (s.kind === 'counter') {
    let total = 0;
    for (const e of entries) total += e.total;
    return { value: round(total), rate: round(rateOf(entries, sec)) };
  }
  let count = 0;
  for (const e of entries) count += e.count;
  const sorted = recent(entries, now);
  return {
    value: count,
    rate: round(rateOf(entries, sec)),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.length ? sorted[sorted.length - 1] : null),
  };
}

function readGauge(s) {
  const points = [];
  if (!s.cb) return points;
  try {
    const out = s.cb();
    if (Array.isArray(out)) {
      for (const p of out) {
        if (p && typeof p.value === 'number' && Number.isFinite(p.value) && points.length < MAX_GAUGE_POINTS) {
          points.push({ value: p.value, attributes: p.attributes || null });
        }
      }
    } else if (typeof out === 'number' && Number.isFinite(out)) {
      points.push({ value: out, attributes: null });
    }
  } catch (_) {}
  return points;
}

function describe(s, room, now) {
  const base = { name: s.name, unit: s.unit, kind: s.kind, description: s.description };
  if (s.kind === 'gauge') {
    const points = readGauge(s);
    let total = 0;
    for (const p of points) total += p.value;
    const out = { ...base, perRoom: points.some((p) => p.attributes && p.attributes['pulse.room'] !== undefined), value: points.length ? round(total) : null };
    const split = points.filter((p) => p.attributes && p.attributes['pulse.room'] === undefined);
    if (split.length) out.points = split.slice(0, 16).map((p) => ({ attributes: p.attributes, value: round(p.value) }));
    if (room !== null) {
      const mine = points.filter((p) => p.attributes && String(p.attributes['pulse.room']) === room);
      out.room = mine.length ? { value: round(mine.reduce((a, p) => a + p.value, 0)) } : null;
    }
    return out;
  }
  const out = { ...base, perRoom: [...s.entries.keys()].some((k) => k !== ''), ...summarize(s, [...s.entries.values()], now) };
  if (room !== null) {
    const e = s.entries.get(room);
    out.room = e ? summarize(s, [e], now) : null;
  }
  return out;
}

function endpointHost() {
  try {
    return new URL(config.OTEL_EXPORTER_OTLP_ENDPOINT).host || null;
  } catch (_) {
    return null;
  }
}

function exportStatus() {
  const m = exportState.metrics;
  const t = exportState.traces;
  return {
    enabled: Boolean(meter),
    startFailed,
    endpointHost: config.OTEL_EXPORTER_OTLP_ENDPOINT ? endpointHost() : null,
    lastExportAt: m.at || null,
    lastExportOk: m.at ? m.ok : null,
    exportFailures: m.failures,
    traces: { lastExportAt: t.at || null, lastExportOk: t.at ? t.ok : null, exportFailures: t.failures },
  };
}

// room: a pulse.room value to add a per-room `room` object to every series, or null.
function snapshot(room = null) {
  const now = Date.now();
  const wanted = room === null || room === undefined || room === '' ? null : String(room);
  const out = [];
  for (const s of series.values()) {
    try { out.push(describe(s, wanted, now)); } catch (_) {}
  }
  return {
    at: now,
    service: { name: SERVICE_NAME, version: SERVICE_VERSION, environment: DEPLOYMENT_ENVIRONMENT, uptimeSec: Math.round(process.uptime()) },
    export: exportStatus(),
    series: out,
  };
}

// Runs fn inside an active span. Propagation and span end are telemetry-only;
// fn's value, promise and errors pass through untouched, and the live path is
// never awaited. span(name, fn) is accepted for callers without attributes.
// A throw or rejection also marks the span ERROR, so Dash0 error rates see it.
function span(name, attrs, fn) {
  if (typeof attrs === 'function') {
    fn = attrs;
    attrs = undefined;
  }
  if (!tracer) return fn();

  const fail = (active, err) => {
    active.recordException(err);
    active.setStatus({ code: api.SpanStatusCode.ERROR, message: err && err.message ? String(err.message) : 'error' });
    active.end();
  };

  let entered = false;
  try {
    return tracer.startActiveSpan(name, { attributes: attrs || {} }, (active) => {
      entered = true;
      try {
        const out = fn(active);
        if (out && typeof out.then === 'function') {
          return out.then(
            (value) => { active.end(); return value; },
            (err) => {
              fail(active, err);
              throw err;
            }
          );
        }
        active.end();
        return out;
      } catch (err) {
        fail(active, err);
        throw err;
      }
    });
  } catch (err) {
    // Only a telemetry failure before fn ran should trigger a direct call.
    if (!entered) return fn();
    throw err;
  }
}

// Structured event -> OTel log record. Synchronous enqueue into the batch
// processor: never awaited, never blocks a request or the live path.
// The active span context is attached so Dash0 links the log to its trace.
function emitLog(level, event, attrs) {
  if (!logger) return;
  const severity = SEVERITY[level] || SEVERITY.info;
  try {
    logger.emit({
      body: event,
      attributes: attrs || {},
      severityNumber: severity,
      severityText: String(level).toUpperCase(),
      context: api.context.active(),
    });
  } catch (_) {}
}

module.exports = { start, counter, histogram, observableGauge, span, emitLog, snapshot, _test: { watchExport, exportStatus } };
