#!/usr/bin/env node
// Applies dash0/ to Dash0: dashboard (Perses), SLOs (OpenSLO subset), check rules.
// Create-or-update by origin/id, then GET-verify. The auth token is read from
// OTEL_EXPORTER_OTLP_HEADERS and never printed.
//
// Usage: node --env-file=.env scripts/dash0-apply.js
// Env: OTEL_EXPORTER_OTLP_HEADERS (required), DASH0_API_URL, DASH0_DATASET.
const fs = require('fs/promises');
const path = require('path');

const API = (process.env.DASH0_API_URL || 'https://api.us-west-2.aws.dash0.com').replace(/\/+$/, '');
const DATASET = process.env.DASH0_DATASET || 'default';
const DIR = path.join(__dirname, '..', 'dash0');

function authToken() {
  const header = process.env.OTEL_EXPORTER_OTLP_HEADERS || '';
  const match = header.match(/Authorization=Bearer\s+([^\s,]+)/i);
  if (!match) throw new Error('OTEL_EXPORTER_OTLP_HEADERS has no Authorization=Bearer token');
  return match[1];
}

const TOKEN = authToken();

async function call(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, error: res.ok ? null : (json && json.error && json.error.message) || text.slice(0, 200) };
}

const q = (endpoint) => `${endpoint}?dataset=${encodeURIComponent(DATASET)}`;

function describe(file, doc) {
  if (file.startsWith('dashboard-')) {
    const origin = doc.metadata && doc.metadata.dash0Extensions && doc.metadata.dash0Extensions.id;
    if (!origin) throw new Error(`${file}: metadata.dash0Extensions.id is required`);
    return {
      type: 'dashboard',
      label: 'dashboard',
      origin,
      name: doc.metadata.name,
      endpoint: `/api/dashboards/${encodeURIComponent(origin)}`,
      body: doc,
    };
  }
  if (file.startsWith('slo-')) {
    const origin = doc.metadata && doc.metadata.labels && doc.metadata.labels['dash0.com/origin'];
    if (!origin) throw new Error(`${file}: metadata.labels["dash0.com/origin"] is required`);
    return {
      type: 'slo',
      label: 'SLO',
      origin,
      name: doc.metadata.name,
      endpoint: `/api/slos/${encodeURIComponent(origin)}`,
      body: doc,
    };
  }
  if (file.startsWith('check-')) {
    if (!doc.id) throw new Error(`${file}: id is required`);
    return {
      type: 'check rule',
      label: 'check rule',
      origin: doc.id,
      name: doc.name,
      endpoint: `/api/alerting/check-rules/${encodeURIComponent(doc.id)}`,
      body: doc,
    };
  }
  throw new Error(`${file}: expected dashboard-*, slo-* or check-*.json`);
}

// PUT to an origin is create-or-replace for all three resource types, so no
// GET/POST branch is needed and repeated runs converge on the same object.
async function apply(item) {
  const method = 'PUT';
  const write = await call(method, q(item.endpoint), item.body);
  if (write.status < 200 || write.status >= 300) {
    throw new Error(`${item.label} ${item.name}: ${method} ${write.status} ${write.error || ''}`.trim());
  }
  const verify = await call('GET', q(item.endpoint));
  if (verify.status !== 200) {
    throw new Error(`${item.label} ${item.name}: verify GET ${verify.status} ${verify.error || ''}`.trim());
  }
  const id = (verify.json && verify.json.id) || item.origin;
  console.log(`${item.label} ${item.name} (${item.origin}) ${method} ${write.status} verify GET 200 id=${id}`);
}

async function main() {
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no JSON definitions in ${DIR}`);
  for (const file of files) {
    const doc = JSON.parse(await fs.readFile(path.join(DIR, file), 'utf8'));
    await apply(describe(file, doc));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
