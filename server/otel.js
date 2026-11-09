// OpenTelemetry -> Dash0 over OTLP/HTTP. No endpoint set = no-op.
// Helpers: counter(name, desc, unit), histogram(name, desc, unit),
// observableGauge(name, desc, cb), span(name, attrs, fn), emitLog(level, event, attrs).
// Exporters read OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS themselves, so Dash0 auth
// (Authorization=Bearer ...) stays in the environment and is never logged here.
const api = require('@opentelemetry/api');
const config = require('./config');

const SERVICE_NAME = config.OTEL_SERVICE_NAME;
const SERVICE_VERSION = process.env.APP_VERSION || 'dev';
const DEPLOYMENT_ENVIRONMENT = process.env.DEPLOY_ENV || 'hackathon';

const noopCounter = { add() {} };
const noopHistogram = { record() {} };

const SEVERITY = { info: api.SeverityNumber.INFO, warn: api.SeverityNumber.WARN, error: api.SeverityNumber.ERROR };

let started = false;
let tracer = null;
let meter = null;
let logger = null;

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

    const sdk = new NodeSDK({
      serviceName: SERVICE_NAME,
      resource,
      traceExporter: new OTLPTraceExporter(),
      // NodeSDK registers this provider with the global logs API, so log.js
      // emits through the same resource and batch pipeline as traces/metrics.
      logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
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
    // Lazy require: log.js reads emitLog from this module.
    try { require('./log').warn('otel.disabled', { error: err.message }); } catch (_) {}
  }
}

function counter(name, description, unit) {
  if (!meter) return noopCounter;
  try {
    return meter.createCounter(name, { description, unit });
  } catch (_) {
    return noopCounter;
  }
}

function histogram(name, description, unit, advice) {
  if (!meter) return noopHistogram;
  try {
    return meter.createHistogram(name, advice ? { description, unit, advice } : { description, unit });
  } catch (_) {
    return noopHistogram;
  }
}

// cb returns either a number or [{ value, attributes }]; each point is observed
// on every export attempt. Telemetry callbacks never throw into the SDK.
// This API version registers async callbacks with addCallback, not createObservableGauge.
function observableGauge(name, description, cb) {
  if (!meter) return;
  try {
    const gauge = meter.createObservableGauge(name, { description });
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

module.exports = { start, counter, histogram, observableGauge, span, emitLog };
