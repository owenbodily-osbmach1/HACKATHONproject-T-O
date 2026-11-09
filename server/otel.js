// OpenTelemetry -> Dash0 over OTLP/HTTP. No endpoint set = no-op.
// Interface: start(), counter(name).add(n, attrs), span(name, fn).
// Exporters read OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS themselves, so Dash0 auth
// (Authorization=Bearer ...) stays in the environment and is never logged here.
const config = require('./config');

const noopCounter = { add() {} };

let started = false;
let tracer = null;
let meter = null;

function start() {
  if (started || !config.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  started = true;
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const api = require('@opentelemetry/api');

    const sdk = new NodeSDK({
      serviceName: config.OTEL_SERVICE_NAME,
      traceExporter: new OTLPTraceExporter(),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 10000,
        }),
      ],
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    });
    sdk.start();
    // index.js loads http and express before otel.start(); re-requiring the
    // cached modules lets the instrumentation hooks patch them (the app and
    // server objects do not exist yet).
    require('http');
    require('express');

    tracer = api.trace.getTracer(config.OTEL_SERVICE_NAME);
    meter = api.metrics.getMeter(config.OTEL_SERVICE_NAME);
  } catch (err) {
    // Telemetry is best-effort: a bad exporter config must never stop the app.
    tracer = null;
    meter = null;
    console.warn('otel: disabled:', err.message);
  }
}

function counter(name) {
  return meter ? meter.createCounter(name) : noopCounter;
}

// Runs fn inside an active span. Propagation and span end are telemetry-only;
// fn's value, promise and errors pass through untouched.
function span(name, fn) {
  if (!tracer) return fn();

  let entered = false;
  try {
    return tracer.startActiveSpan(name, (active) => {
      entered = true;
      try {
        const out = fn(active);
        if (out && typeof out.then === 'function') {
          return out.then(
            (value) => { active.end(); return value; },
            (err) => {
              active.recordException(err);
              active.end();
              throw err;
            }
          );
        }
        active.end();
        return out;
      } catch (err) {
        active.recordException(err);
        active.end();
        throw err;
      }
    });
  } catch (err) {
    // Only a telemetry failure before fn ran should trigger a direct call.
    if (!entered) return fn();
    throw err;
  }
}

module.exports = { start, counter, span };
