import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockChain, hexAddr } from './runtime.mjs';

const SOURCE = readFileSync(new URL('../contracts/canary.js', import.meta.url), 'utf8');
const OWNER = hexAddr(1);
const CRON = hexAddr(6);
const MALLORY = hexAddr(0xbad);
const MIN = 60000;
const HOUR = 3600000;

function setup() {
  const chain = new MockChain();
  const c = chain.deploy(SOURCE);
  c.send(OWNER, 'init', [CRON, MIN]);
  return { chain, c };
}

test('source stays under the 64 KB contract limit', () => {
  assert.ok(Buffer.byteLength(SOURCE) < 64 * 1024);
});

test('init validates and runs once', () => {
  const chain = new MockChain();
  const c = chain.deploy(SOURCE);
  assert.throws(() => c.send(OWNER, 'init', ['ase1xyz', MIN]), /cron must be an address/);
  assert.throws(() => c.send(OWNER, 'init', [CRON, 1000]), /at least 60000/);
  c.send(OWNER, 'init', [CRON.toUpperCase().replace('0X', '0x'), MIN]);
  assert.throws(() => c.send(OWNER, 'init', [CRON, MIN]), /already initialized/);
  const s = c.view('status');
  assert.equal(s.cron, CRON);
  assert.equal(s.intervalMs, MIN);
  assert.equal(s.ticks, 0);
});

test('only the cron registry can tick', () => {
  const { c } = setup();
  assert.throws(() => c.send(MALLORY, 'tick'), /only the cron registry/);
  assert.throws(() => c.send(OWNER, 'tick'), /only the cron registry/);
  assert.equal(c.send(CRON, 'tick'), 'ok');
});

test('regular ticks: no misses, block time per hour', () => {
  const { chain, c } = setup();
  for (let i = 0; i < 120; i++) {
    c.send(CRON, 'tick');
    chain.advance(MIN, 30);
  }
  const s = c.view('status');
  assert.equal(s.ticks, 120);
  assert.equal(s.missed, 0);
  assert.deepEqual(c.view('incidents'), []);
  const b = c.view('buckets');
  assert.equal(b.length, 2);
  const [, ticks, maxGap, blocks, ms] = b[1];
  assert.equal(ticks, 60);
  assert.equal(maxGap, MIN);
  assert.equal(ms / blocks, 2000);
});

test('a stall becomes an incident with the right gap and misses', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  chain.advance(MIN, 30);
  c.send(CRON, 'tick');
  const before = c.view('status');
  chain.advance(10 * MIN, 1); // chain halted for ~10 minutes
  c.send(CRON, 'tick');
  const s = c.view('status');
  assert.equal(s.missed, 9);
  const inc = c.view('incidents');
  assert.equal(inc.length, 1);
  assert.equal(inc[0].gap, 10 * MIN);
  assert.equal(inc[0].from, before.last);
  assert.equal(inc[0].toBlock - inc[0].fromBlock, 1);
  assert.deepEqual(c.events.at(-1), { name: 'Stall', data: { from: before.last, to: s.last, gap: 10 * MIN } });
});

test('short delays count as misses but are not incidents', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  chain.advance(2 * MIN);
  c.send(CRON, 'tick');
  assert.equal(c.view('status').missed, 1);
  assert.equal(c.view('incidents').length, 0);
});

test('extra runs within half an interval are ignored', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  chain.advance(20000);
  assert.equal(c.send(CRON, 'tick'), 'ignored: too early');
  chain.advance(40000);
  assert.equal(c.send(CRON, 'tick'), 'ok');
  assert.equal(c.view('status').ticks, 2);
});

test('incidents keep the newest 20, buckets keep 48 hours', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  for (let i = 0; i < 25; i++) {
    chain.advance(5 * MIN);
    c.send(CRON, 'tick');
  }
  const inc = c.view('incidents');
  assert.equal(inc.length, 20);
  assert.ok(inc[19].to > inc[0].to);

  for (let h = 0; h < 60; h++) {
    chain.advance(HOUR / 2);
    c.send(CRON, 'tick');
    chain.advance(HOUR / 2);
    c.send(CRON, 'tick');
  }
  assert.equal(c.view('buckets').length, 48);
});

test('snapshot bundles status, recent ticks, buckets and incidents', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  const t0 = [Number(chain.time), Number(chain.block)];
  chain.advance(MIN, 30);
  c.send(CRON, 'tick');
  const snap = c.view('snapshot');
  assert.equal(snap.status.ticks, 2);
  assert.deepEqual(snap.recent, [t0, [t0[0] + MIN, t0[1] + 30]]);
  assert.equal(snap.buckets.length, 1);
  assert.deepEqual(snap.incidents, []);
});

test('recent ticks keep the last 120, ignored runs are not recorded', () => {
  const { chain, c } = setup();
  for (let i = 0; i < 130; i++) {
    c.send(CRON, 'tick');
    chain.advance(MIN);
  }
  chain.advance(-MIN + 10000);
  c.send(CRON, 'tick'); // too early, ignored
  const r = c.view('recent');
  assert.equal(r.length, 120);
  assert.equal(r.at(-1)[0], c.view('status').last);
  for (let i = 1; i < r.length; i++) assert.equal(r[i][0] - r[i - 1][0], MIN);
});

test('setJob and ownership are owner-only', () => {
  const { c } = setup();
  assert.throws(() => c.send(MALLORY, 'setJob', ['7']), /only the owner/);
  c.send(OWNER, 'setJob', [7]);
  assert.equal(c.view('status').job, '7');
  c.send(OWNER, 'transferOwnership', [MALLORY]);
  assert.equal(c.view('status').owner, MALLORY);
  assert.throws(() => c.send(OWNER, 'setJob', ['8']), /only the owner/);
});

test('storage gas per tick fits a 1,000,000 gas job limit with room', () => {
  const { chain, c } = setup();
  c.send(CRON, 'tick');
  chain.advance(MIN);
  c.send(CRON, 'tick');
  assert.ok(c.gas < 30000, `steady-state tick storage gas ${c.gas}`);
});
