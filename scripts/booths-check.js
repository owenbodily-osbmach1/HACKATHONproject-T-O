#!/usr/bin/env node
// Offline checks for server/booths.js pure helpers. No server, no network.
const assert = require('assert');
const { _test } = require('../server/booths');

const {
  SUSPECT_MS, isSuspect, passport, excludedBooths, localNext, topicList, talkList,
} = _test;

// Passport counting ignores rejected stamps.
const stamps = new Map([
  ['gitar', new Map([['dev-1', { ts: 1000, suspect: false }]])],
  ['dash0', new Map([['dev-1', { ts: 2000, suspect: false }]])],
  ['radar', new Map([['dev-1', { ts: 3000, suspect: true }]])],
]);
assert.strictEqual(passport(stamps, 'dev-1'), 2, 'only real stamps count');
assert.strictEqual(passport(stamps, 'dev-2'), 0, 'unknown device has no stamps');
assert.deepStrictEqual([...excludedBooths(stamps, 'dev-1')].sort(), ['dash0', 'gitar', 'radar']);

// Suspect rule: a different booth inside 30 s is rejected, not before or after.
const prior = { booth: 'gitar', ts: 1000 };
assert.strictEqual(isSuspect(prior, 'dash0', 1000 + SUSPECT_MS - 1), true);
assert.strictEqual(isSuspect(prior, 'dash0', 1000 + SUSPECT_MS), false);
assert.strictEqual(isSuspect(prior, 'gitar', 1000 + 1), false, 'same booth is not suspect');
assert.strictEqual(isSuspect(null, 'dash0', 1000), false);

// k >= 3: buckets with fewer than three devices are dropped.
const two = [
  { clientId: 'd1', heard: ['Kubernetes cluster management'], fromTalks: ['talk-1'] },
  { clientId: 'd2', heard: ['Kubernetes cluster management'], fromTalks: ['talk-1'] },
];
assert.deepStrictEqual(topicList(two), []);
assert.deepStrictEqual(talkList(two), []);
const three = [...two, { clientId: 'd3', heard: ['Kubernetes cluster management'], fromTalks: ['talk-1'] }];
const topics = topicList(three);
assert.deepStrictEqual(topics.map((t) => t.text).sort(), ['cluster management', 'kubernetes cluster']);
assert.ok(topics.every((t) => t.devices === 3));
assert.deepStrictEqual(talkList(three), [{ talkId: 'talk-1', devices: 3 }]);

// Next booth never returns a booth the device already stamped.
const heard = ['Gitar reviews pull requests and applies fixes in continuous integration'];
const withoutGitar = localNext(heard, new Set(['gitar']));
assert.ok(withoutGitar, 'a booth remains');
assert.notStrictEqual(withoutGitar.id, 'gitar', 'stamped booth is excluded');
const onlyElastic = new Set(['gitar', 'dash0', 'radar', 'openai', 'merge-forward']);
assert.strictEqual(localNext(heard, onlyElastic).id, 'elastic');
assert.strictEqual(localNext([], new Set(['gitar', 'dash0', 'radar', 'openai', 'merge-forward'])).id, 'elastic');

console.log('booths-check: ok');
