// In-process check for the OTel mirror and GET /api/metrics. Run: node scripts/metrics-check.js
// No network, no env needed: the OTLP exporter stays off and a fake exporter stands in for it.
const assert = require('assert');

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer super-secret-token';
const otel = require('../server/otel');

const find = (snap, name) => snap.series.find((s) => s.name === name);

(async () => {
  // counters: totals, per-room slice, rate, bad input
  {
    const c = otel.counter('check.frames', 'Frames', '{frame}');
    for (let i = 0; i < 30; i++) c.add(1, { 'pulse.room': '1' });
    c.add(5, { 'pulse.room': '2' });
    c.add(1);
    c.add(NaN, { 'pulse.room': '1' });
    c.add('x', { 'pulse.room': '1' });
    c.add(Infinity);
    const s = find(otel.snapshot('1'), 'check.frames');
    assert.equal(s.kind, 'counter');
    assert.equal(s.unit, '{frame}');
    assert.equal(s.value, 36);
    assert.equal(s.room.value, 30);
    assert.ok(s.rate > 0 && s.room.rate > 0 && s.room.rate < s.rate, 'rate is per second and per room');
    assert.equal(s.perRoom, true);
    assert.equal(find(otel.snapshot('nope'), 'check.frames').room, null);
    assert.equal(find(otel.snapshot(), 'check.frames').room, undefined);
  }

  // memory stays bounded: room labels are capped, histograms keep a fixed window
  {
    const c = otel.counter('check.many', 'Many', '1');
    for (let i = 0; i < 500; i++) c.add(1, { 'pulse.room': `r${i}` });
    assert.equal(find(otel.snapshot(), 'check.many').value, 500, 'overflow rooms still count in the total');
    const h = otel.histogram('check.window', 'Window', 'ms');
    for (let i = 1; i <= 1000; i++) h.record(i, { 'pulse.room': '1' });
    const hs = find(otel.snapshot('1'), 'check.window');
    assert.equal(hs.value, 1000);
    assert.ok(hs.room.p50 > 700 && hs.room.p95 > hs.room.p50 && hs.room.max === 1000, 'percentiles use only the recent window');
  }

  // histogram percentiles
  {
    const h = otel.histogram('check.latency', 'Latency', 'ms');
    for (let i = 1; i <= 100; i++) h.record(i, { 'pulse.room': '7' });
    const s = find(otel.snapshot('7'), 'check.latency').room;
    assert.equal(s.p50, 50);
    assert.equal(s.p95, 95);
    assert.equal(s.max, 100);
    assert.equal(s.value, 100);
    assert.ok(s.rate > 0);
    otel.histogram('check.empty', 'Empty', 's');
    assert.equal(find(otel.snapshot(), 'check.empty').p95, null);
  }

  // gauges: number, per-room points, split points, a callback that throws
  {
    otel.observableGauge('check.gauge.num', 'Num', () => 4, '{x}');
    otel.observableGauge('check.gauge.rooms', 'Rooms', () => [
      { value: 2, attributes: { 'pulse.room': '1' } },
      { value: 3, attributes: { 'pulse.room': '2' } },
    ]);
    otel.observableGauge('check.gauge.roles', 'Roles', () => [{ value: 1, attributes: { 'pulse.role': 'tech' } }]);
    otel.observableGauge('check.gauge.boom', 'Boom', () => { throw new Error('boom'); });
    const snap = otel.snapshot('2');
    assert.equal(find(snap, 'check.gauge.num').value, 4);
    assert.equal(find(snap, 'check.gauge.num').room, null);
    assert.equal(find(snap, 'check.gauge.rooms').value, 5);
    assert.equal(find(snap, 'check.gauge.rooms').room.value, 3);
    assert.equal(find(snap, 'check.gauge.roles').points[0].attributes['pulse.role'], 'tech');
    assert.equal(find(snap, 'check.gauge.boom').value, null);
  }

  // recording is cheap enough for 10 audio frames per second per room
  {
    const c = otel.counter('check.hot', 'Hot', '{frame}');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200000; i++) c.add(1, { 'pulse.room': '1' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `200k counter adds took ${ms} ms`);
  }

  // export status wraps the exporter callback without changing it
  {
    const seen = [];
    const exporter = { export(items, done) { seen.push(items); done({ code: items === 'bad' ? 1 : 0 }); } };
    otel._test.watchExport(exporter, 'metrics');
    let result = null;
    exporter.export('good', (r) => { result = r; });
    assert.deepEqual(result, { code: 0 });
    assert.equal(otel._test.exportStatus().lastExportOk, true);
    exporter.export('bad', () => {});
    const st = otel._test.exportStatus();
    assert.equal(st.lastExportOk, false);
    assert.equal(st.exportFailures, 1);
    assert.ok(st.lastExportAt > 0);
    assert.equal(st.enabled, false, 'no endpoint: exporting is off');
    assert.deepEqual(seen, ['good', 'bad']);
  }

  // route: key, shape, no secrets
  {
    const metrics = require('../server/av-metrics');
    const routes = [];
    const app = { get: (path, ...handlers) => routes.push({ path, handlers }) };
    const ctx = {
      config: { DASH0_URL: 'https://app.dash0.com/dashboards/x', TECH_KEY: 'tech' },
      state: { rooms: new Map([['1', { room: '1' }]]) },
      auth: { api: () => (req, res, next) => (req.get('x-pulse-key') === 'tech' ? next() : res.status(401).json({ error: 'unauthorized' })) },
      hub: { roleCount: (room, role) => (role === 'attendee' ? 3 : 0) },
      es: { enabled: true, stats: () => ({ enabled: true, writes: 10, writeErrors: 1, lastErrorAt: 5 }) },
    };
    metrics.register(app, ctx);
    const route = routes.find((r) => r.path === '/api/metrics');
    assert.ok(route, 'GET /api/metrics is registered');

    const call = (key, query) => new Promise((resolve) => {
      const res = {
        code: 200,
        headers: {},
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.code = c; return this; },
        json(b) { resolve({ code: this.code, body: b, headers: this.headers }); },
      };
      const req = { get: (n) => (n === 'x-pulse-key' ? key : undefined), query };
      let i = 0;
      const next = () => { const h = route.handlers[i++]; if (h) h(req, res, next); };
      next();
    });

    assert.equal((await call(undefined, {})).code, 401);
    assert.equal((await call('wrong', {})).code, 401);
    const ok = await call('tech', { room: '1' });
    assert.equal(ok.code, 200);
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    const b = ok.body;
    assert.equal(b.dash0.enabled, false);
    assert.equal(b.dash0.url, 'https://app.dash0.com/dashboards/x');
    assert.equal(b.service.name, 'pulse');
    assert.ok(Number.isFinite(b.service.uptimeSec));
    assert.equal(b.es.enabled, true);
    assert.equal(b.es.writes, 10);
    assert.equal(b.es.queued, null, 'missing ES fields are null');
    assert.equal(find(b, 'pulse.ws.connections').value, 3);
    assert.ok(find(b, 'process.memory.usage').value > 0);
    assert.equal(find(b, 'pulse.es.writes').value, 10);
    assert.ok(!JSON.stringify(b).includes('super-secret-token'), 'headers never leave the process');

    ctx.es = { enabled: false };
    assert.equal(metrics._test.esStats().enabled, false);
    ctx.es = { stats: () => { throw new Error('x'); } };
    assert.equal(metrics._test.esStats().enabled, false, 'a throwing es.stats() is tolerated');
    ctx.config.DASH0_URL = 'javascript:alert(1)';
    const plain = await call('tech', {});
    assert.equal(plain.body.dash0.url, null, 'only http(s) links are offered');
    assert.equal(plain.body.room, null);
  }

  console.log('metrics-check: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
