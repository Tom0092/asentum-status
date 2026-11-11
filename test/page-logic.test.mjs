// The status page's arithmetic (site/logic.js), without a browser.
// Expectations avoid numbers of 1,000 and more, so the test does not depend on
// the locale's thousands separator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toAse1 } from '../site/vendor/asentum-sdk.js';
import {
  MIN,
  HOUR,
  STALE_MS,
  fmtDur,
  fmtAgo,
  verdict,
  nextFinality,
  recentBlockTime,
  opStatus,
  opUptime,
  opLatency,
  hourRows,
  niceScale,
  signingStatus,
  buildRows,
  stopHint,
  FILTERS,
} from '../site/logic.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = 498500 * HOUR + 20 * MIN; // 20 minutes into an hour
const hexAddr = (n) => '0x' + n.toString(16).padStart(40, '0');

test('the DOM part of the page parses', () => {
  for (const f of ['site/app.js', 'site/demo.js', 'site/logic.js']) {
    execFileSync(process.execPath, ['--check', f], { cwd: ROOT });
  }
});

test('fmtDur rounds before it splits hours and minutes', () => {
  assert.equal(fmtDur(0), '0 s');
  assert.equal(fmtDur(59400), '59 s');
  assert.equal(fmtDur(59600), '1 min', 'never "60 s"');
  assert.equal(fmtDur(59.6 * MIN), '1 h', 'never "60 min"');
  assert.equal(fmtDur(HOUR + 59.6 * MIN), '2 h', 'never "1 h 60 min"');
  assert.equal(fmtDur(5 * HOUR + 30 * MIN), '5 h 30 min');
  assert.equal(fmtDur(49 * HOUR), '2 days');
  assert.equal(fmtDur(-5000), '0 s');
  assert.equal(fmtAgo(1000), 'just now');
  assert.equal(fmtAgo(90000), '2 min ago');
});

test('niceScale picks round steps', () => {
  const a = niceScale(30, 30, 3);
  assert.equal(a.max, 30);
  assert.equal(a.ticks, 3);
  const b = niceScale(7, 5, 3);
  assert.equal(b.max, 7.5);
  assert.equal(b.fmt(2.5), '2.5');
  const c = niceScale(0, 5, 3);
  assert.ok(c.max >= 5);
});

// ------------------------------------------------------------------ verdict

function healthy(over = {}) {
  return {
    heads: { tip: 902, finalized: 900 },
    chain: { timestamp: NOW - 5000 },
    canary: { status: { last: NOW - 30000, intervalMs: MIN } },
    finalSeen: { height: 900, at: NOW - 10000, moved: true },
    errors: {},
    updatedAt: NOW - 1000,
    ...over,
  };
}

test('verdict: checking, unknown only after STALE_MS, running', () => {
  assert.equal(verdict({ heads: null, chain: null, errors: {}, updatedAt: 0 }, NOW, 'rpc').label, 'Checking');

  const err = new Error('timeout');
  const recent = verdict(healthy({ errors: { heads: err }, updatedAt: NOW - (STALE_MS - 1000) }), NOW, 'rpc');
  assert.equal(recent.label, 'Running', 'one failed read keeps the last good reading');
  assert.match(recent.detail, /dropping requests/);

  const old = verdict(healthy({ errors: { heads: err }, updatedAt: NOW - (STALE_MS + 1000) }), NOW, 'rpc');
  assert.equal(old.label, 'Unknown');
  assert.match(old.detail, /rpc has not answered/);

  assert.equal(verdict(healthy(), NOW, 'rpc').label, 'Running');
});

test('verdict: late finality is Degraded while it moves, Stalled when it stops', () => {
  const late = verdict(healthy({ chain: { timestamp: NOW - 3 * MIN }, finalSeen: { height: 900, at: NOW - 30000, moved: true } }), NOW, 'rpc');
  assert.equal(late.level, 'warning');
  assert.equal(late.title, 'Finality is far behind');

  const stalled = verdict(healthy({ chain: { timestamp: NOW - 5 * MIN }, finalSeen: { height: 900, at: NOW - 3 * MIN, moved: true } }), NOW, 'rpc');
  assert.equal(stalled.level, 'critical');
  assert.equal(stalled.label, 'Stalled');

  const lag = verdict(healthy({ heads: { tip: 940, finalized: 900 } }), NOW, 'rpc');
  assert.equal(lag.title, 'Finality is falling behind');

  const canary = verdict(healthy({ canary: { status: { last: NOW - 4 * MIN, intervalMs: MIN } } }), NOW, 'rpc');
  assert.equal(canary.title, 'Blocks are final, but scheduled jobs are late');
});

test('nextFinality remembers when the final height last moved', () => {
  const a = nextFinality(null, 900, 1000);
  assert.deepEqual(a, { height: 900, at: 1000, moved: false });
  assert.equal(nextFinality(a, 900, 5000), a, 'same height keeps the old time');
  assert.deepEqual(nextFinality(a, 901, 6000), { height: 901, at: 6000, moved: true });
});

test('recentBlockTime measures the newest hour of ticks', () => {
  const recent = [];
  for (let i = 0; i <= 120; i++) recent.push([NOW - (120 - i) * MIN, 1000 + i * 25]);
  const bt = recentBlockTime({ recent });
  assert.equal(bt.blocks, 60 * 25);
  assert.equal(bt.ms, 2400);
  assert.equal(recentBlockTime({ recent: recent.slice(0, 1) }), null);
});

// ------------------------------------------------------------------ heartbeats

test('opStatus: online up to two intervals, late up to six, then offline', () => {
  const iv = 300000;
  const at = (age) => opStatus({ interval: 300, last: NOW - age }, NOW).key;
  assert.equal(opStatus({ interval: 300, last: 0 }, NOW).key, 'waiting');
  assert.equal(at(2 * iv + MIN), 'ok');
  assert.equal(at(2 * iv + MIN + 1), 'late');
  assert.equal(at(6 * iv), 'late');
  assert.equal(at(6 * iv + 1), 'offline');
});

// Beats on the systemd grid (*:0/5), each landing 15 s after its slot.
function gridOp({ skip = [], joined = NOW - 60 * HOUR } = {}) {
  const hist = new Map();
  let last = 0;
  for (let t = Math.ceil(joined / 300000) * 300000; t + 15000 <= NOW; t += 300000) {
    if (skip.includes(t)) continue;
    const land = t + 15000;
    const h = Math.floor(land / HOUR);
    hist.set(h, (hist.get(h) || 0) + 1);
    last = land;
  }
  return { interval: 300, joined, last, hist: [...hist].map(([h, n]) => [h, n, n * 2000, 3000, n]) };
}

test('opUptime: a healthy grid timer reads 100 %, two missed beats do not', () => {
  assert.equal(opUptime(gridOp(), NOW, 48).pct, 100);
  const slot = 498480 * HOUR;
  const missed = opUptime(gridOp({ skip: [slot, slot + 300000] }), NOW, 48);
  assert.ok(missed.pct < 100, `pct ${missed.pct}`);
  const cell = missed.cells.find((c) => c.h === 498480);
  assert.equal(cell.beats, 10);
  assert.equal(cell.expected, 12);
});

test('opUptime: hours before joining and the first minutes of an hour', () => {
  const op = gridOp({ joined: NOW - 3 * HOUR });
  const u = opUptime(op, NOW, 48);
  assert.equal(u.cells.length, 48);
  assert.equal(u.cells[0].level, 'x');
  assert.equal(u.cells[0].why, 'not registered yet');
  assert.equal(u.pct, 100);

  const early = 498500 * HOUR + 2 * MIN;
  const e = opUptime({ ...op, hist: op.hist.filter((b) => b[0] < 498500) }, early, 48);
  const cur = e.cells[e.cells.length - 1];
  assert.equal(cur.expected, 0);
  assert.equal(cur.why, 'too early to tell');
});

test('opLatency averages over the buckets', () => {
  const L = opLatency({ lat: 1500, hist: [[1, 2, 4000, 2500, 2], [2, 1, 1000, 1000, 1], [3, 1, 0, 0, 0]] });
  assert.equal(L.last, 1500);
  assert.equal(L.avg, 5000 / 3);
  assert.equal(opLatency({ lat: -1, hist: [] }).avg, null);
});

// ------------------------------------------------------------------ canary hours

test('hourRows counts missed minutes, the running hour only up to now', () => {
  const end = Math.floor(NOW / HOUR);
  const canary = {
    status: { first: NOW - 10 * HOUR, intervalMs: MIN },
    buckets: [
      [end - 3, 60, 61000, 1500, 3600000],
      [end - 2, 50, 11 * MIN, 1250, 3600000],
      [end, 19, 61000, 475, 19 * MIN],
    ],
  };
  const rows = hourRows(canary, NOW);
  const by = new Map(rows.map((r) => [r.h, r]));
  assert.equal(by.get(end - 3).missedMin, 0);
  assert.equal(by.get(end - 2).missedMin, 10);
  assert.equal(by.get(end - 1).missedMin, 60, 'an hour without a bucket had no ticks');
  assert.equal(by.get(end).missedMin, 0, 'the running hour expects one tick less');
  assert.equal(by.get(end - 3).blockMs, 2400);
  assert.equal(hourRows({ status: { first: 0 } }, NOW).length, 0);
});

// ------------------------------------------------------------------ validators

const A = toAse1(hexAddr(0xa));
const B = toAse1(hexAddr(0xb));
const C = toAse1(hexAddr(0xc));

function val(address, status, extra = {}) {
  return { address, status, stake: String(2000n * 10n ** 18n), participationRatio: status === 'signing' ? 0.98 : 0.2, lastSignedBlock: '890', ...extra };
}

test('signingStatus: no participation list means unknown, never "not bonded"', () => {
  assert.equal(signingStatus(null, null, { part: null, errors: {} }).label, 'Loading signatures…');
  assert.equal(signingStatus(null, null, { part: null, errors: { part: new Error('503') } }).label, 'Signature data unavailable');
  assert.equal(signingStatus(null, null, { part: { lookback: 1000 }, errors: {} }).label, 'Not in the validator set');
});

test('signingStatus: signing, missing votes, not voting, outside', () => {
  const s = { part: { lookback: 1000, recentWindow: 100 }, live: { maxConsecutiveMisses: 50 }, errors: {} };
  assert.equal(signingStatus(val(A, 'signing'), { consecutiveMisses: 0 }, s).label, 'Signing');
  assert.equal(signingStatus(val(A, 'signing'), { consecutiveMisses: 3 }, s).label, 'Missing votes');
  assert.equal(signingStatus(val(A, 'signing'), { consecutiveMisses: 50 }, s).label, 'Not voting');
  assert.equal(signingStatus(val(A, 'idle'), null, s).label, 'Idle');
  assert.equal(signingStatus(val(A, 'dormant'), null, s).key, 'outside');
});

test('buildRows: registry and signatures merged, problems first', () => {
  const state = {
    ops: [
      { addr: hexAddr(0x101), name: 'named', validator: hexAddr(0xa), interval: 0, last: 0 },
      { addr: hexAddr(0x102), name: 'gone', validator: hexAddr(0xc), interval: 300, last: NOW - 60000, hist: [] },
      { addr: hexAddr(0x103), name: 'loose', validator: '', interval: 300, last: NOW - 60000, hist: [] },
    ],
    part: { lookback: 1000, recentWindow: 100, validators: [val(A, 'signing'), val(B, 'idle')] },
    live: { maxConsecutiveMisses: 50, tracked: [{ address: hexAddr(0xa), consecutiveMisses: 0 }, { address: hexAddr(0xb), consecutiveMisses: 60 }] },
    errors: {},
  };
  const rows = buildRows(state, NOW);
  assert.equal(rows.length, 4, 'two validators, one registry entry for an unbonded validator, one without validator');
  assert.equal(rows[0].address, B, 'the validator that stopped voting comes first');
  assert.equal(rows[0].sig.label, 'Not voting');
  const named = rows.find((r) => r.op?.name === 'named');
  assert.equal(named.address, A);
  assert.equal(named.sig.label, 'Signing');
  assert.equal(named.hb, null, 'name only, no heartbeat status');
  const gone = rows.find((r) => r.op?.name === 'gone');
  assert.equal(gone.address, C);
  assert.equal(gone.sig.label, 'Not in the validator set');
  assert.equal(gone.hb.key, 'ok');
  const loose = rows.find((r) => r.op?.name === 'loose');
  assert.equal(loose.address, '');
  assert.equal(loose.sig, null);
  assert.equal(rows.filter(FILTERS.problems).length, 1);
  assert.equal(rows.filter(FILTERS.named).length, 3);
  assert.equal(rows.filter(FILTERS.signing).length, 1);
});

test('stopHint names the block of the last beat while the network runs', () => {
  const op = { lastBlock: 100 };
  const off = { key: 'offline' };
  assert.match(stopHint(op, off, 160, 'good'), /block #100, the chain is 60 blocks further\. The network is running/);
  assert.doesNotMatch(stopHint(op, off, 160, 'warning'), /network is running/);
  assert.equal(stopHint(op, off, 160, 'critical'), null);
  assert.equal(stopHint(op, { key: 'late' }, 160, 'good'), null);
  assert.equal(stopHint(op, off, 100, 'good'), null);
});
