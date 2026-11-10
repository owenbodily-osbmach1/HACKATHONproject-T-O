#!/usr/bin/env node
// One command to run Pulse on any computer (Windows, macOS, Linux): `npm run demo`.
// See docs/QUICKSTART.md.
//
//   node scripts/start.js [--phones] [--room 151] [--port 8080] [--signin] [--no-open]
//
// It makes fresh keys, starts the server with the demo room, prints every link and opens
// Go live and the AV console in your browser. Ctrl+C stops everything.
//   --phones   also start a free Cloudflare tunnel (needs `cloudflared`) so phones on mobile
//              data can scan the QR code. Without it, phones on the same Wi-Fi can join.
//   --signin   keep the one-time sign-in form for phones (off by default here).
// Keys already set in the environment or in .env are kept. No Elasticsearch or Dash0 needed.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const room = String(valueOf('--room', '151')).replace(/[^A-Za-z0-9_-]/g, '') || '151';
const wantPort = Number(valueOf('--port', process.env.PORT || 8080)) || 8080;
const children = [];

function fileEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[2]) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return out;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error(`no free port between ${start} and ${start + 19}`);
}

// The Wi-Fi / Ethernet address phones in the room can reach: a private range only, so a VPN
// address (Tailscale and friends use 100.64.0.0/10) is never put in the QR code.
function lanAddress() {
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) return a.address;
    }
  }
  return '';
}

// Starts cloudflared and resolves with its public https URL, or '' when it is missing or slow.
function startTunnel(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (url) => { if (!done) { done = true; resolve(url); } };
    let child;
    try {
      child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return finish(''); }
    children.push(child);
    child.on('error', () => finish(''));
    child.on('exit', () => finish(''));
    const onData = (d) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
      if (m) finish(m[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => finish(''), 30000);
  });
}

async function waitForServer(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('the server stopped while starting (see the lines above)');
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the server did not answer on ' + base);
}

function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const c = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    c.on('error', () => {});
    c.unref();
  } catch {}
}

function stopAll() {
  for (const c of children) { try { c.kill(); } catch {} }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
    console.error('Packages are not installed yet. Run this first, then try again:\n\n  npm ci\n');
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`Node ${process.versions.node} is too old. Install Node 22 from https://nodejs.org and try again.`);
    process.exit(1);
  }

  const saved = fileEnv();
  const pick = (name) => process.env[name] || saved[name] || '';
  const speakerKey = pick('SPEAKER_KEY') || crypto.randomBytes(6).toString('hex');
  const techKey = pick('TECH_KEY') || crypto.randomBytes(6).toString('hex');
  const boothKey = pick('BOOTH_KEY') || crypto.randomBytes(6).toString('hex');
  const port = await pickPort(wantPort);
  const local = `http://localhost:${port}`;

  let publicBase = pick('PUBLIC_BASE_URL');
  let phones = publicBase ? 'your PUBLIC_BASE_URL' : '';
  if (!publicBase && has('--phones')) {
    console.log('Starting the public tunnel (cloudflared)...');
    publicBase = await startTunnel(port);
    if (publicBase) phones = 'any phone, on Wi-Fi or mobile data';
    else console.log('cloudflared is not installed or did not connect. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or carry on with same-Wi-Fi phones.');
  }
  if (!publicBase) {
    const ip = lanAddress();
    publicBase = ip ? `http://${ip}:${port}` : local;
    phones = ip ? 'phones on the same Wi-Fi as this computer' : 'this computer only (no network found)';
  }

  const env = {
    ...saved,
    ...process.env,
    PORT: String(port),
    SPEAKER_KEY: speakerKey,
    TECH_KEY: techKey,
    BOOTH_KEY: boothKey,
    PUBLIC_BASE_URL: publicBase,
    // One phone is enough to raise a ticket when you try it alone; a real event uses 3.
    ALERT_THRESHOLD: pick('ALERT_THRESHOLD') || '1',
    SIGNIN: has('--signin') ? 'on' : pick('SIGNIN') || 'off',
  };
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(server);
  server.on('exit', (code) => { if (code) console.error(`The server stopped (code ${code}).`); stopAll(); process.exit(code || 0); });
  await waitForServer(local, server);

  // The podium pages need the microphone, which browsers only allow on localhost or https.
  const speakerBase = publicBase.startsWith('https://') ? publicBase : local;
  const go = `${speakerBase}/go/${room}?key=${speakerKey}`;
  const tech = `${local}/tech?key=${techKey}`;
  const line = (label, url) => console.log(`  ${label.padEnd(26)} ${url}`);
  console.log('\nPulse is running. Leave this window open; press Ctrl+C to stop.\n');
  line('1. Go live (speaker)', go);
  line('2. AV tech console', tech);
  line('3. Audience phone page', `${publicBase}/r/${room}`);
  line('   Same page, this computer', `${local}/r/${room}`);
  line('   Demo room (always live)', `${local}/r/255`);
  line('   Organizer overview', `${local}/org`);
  console.log(`\n  The QR code on Go live works for: ${phones}.`);
  if (!has('--phones') && !pick('PUBLIC_BASE_URL')) console.log('  For phones on mobile data, stop this and run:  npm run demo -- --phones');
  console.log('  These links contain keys. Do not put them on a projector.\n');

  if (!has('--no-open')) { openInBrowser(go); setTimeout(() => openInBrowser(tech), 700); }
}

process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
main().catch((err) => { console.error('Could not start Pulse: ' + err.message); stopAll(); process.exit(1); });
