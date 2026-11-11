// The daily history (scripts/history-lib.mjs) and how the page lays it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedDays, signingSample, updateHistory, formatJson, KEEP_DAYS } from '../scripts/history-lib.mjs';
import { MIN, HOUR, DAY, dayKey, daySlots, mergeIncidents } from '../site/logic.js';

const D0 = 20400; // a UTC day number
const at = (day, hour, min = 0) => day * DAY + hour * HOUR + min * MIN;

// A canary that ticked every minute from `first` to `now`, except in `gaps`
// ([fromMs, toMs) without ticks). Buckets as the contract keeps them: the
// newest 48 hours before the last tick.
function canary(first, now, gaps = []) {
  const buckets = new Map();
  const incidents = [];
  let last = 0;
  for (let t = first; t <= now; t += MIN) {
    if (gaps.some(([a, b]) => t >= a && t < b)) continue;
    const gap = last ? t - last : 0;
    const h = Math.floor(t / HOUR);
    const b = buckets.get(h) || [h, 0, 0, 0, 0];
    b[1] += 1;
    b[2] = Math.max(b[2], gap);
    b[3] += last ? 24 : 0;
    b[4] += gap;
    buckets.set(h, b);
    if (gap >= 3 * MIN) incidents.push({ from: last, to: t, gap, fromBlock: 0, toBlock: 0 });
    last = t;
  }
  const newest = Math.floor(last / HOUR);
  return {
    status: { first, last, intervalMs: MIN, keepHours: 48 },
    buckets: [...buckets.values()].filter((b) => b[0] > newest - 48),
    incidents: incidents.slice(-20),
  };
}

test('only finished days whose 24 hours are all still in the window', () => {
  const first = at(D0, 0);
  // 00:17 UTC: yesterday is finished and complete, the day before lost its first hour.
  let now = at(D0 + 3, 0, 17);
  let rows = finishedDays(canary(first, now), now);
  assert.deepEqual(rows.map((r) => r.day), [dayKey(at(D0 + 2, 0))]);
  assert.equal(rows[0].ticks, 1440);
  assert.equal(rows[0].missedMin, 0);
  assert.equal(rows[0].blockMs, 2500, '60 s per tick over 24 blocks');

  // 23:30 UTC the next day: still complete.
  now = at(D0 + 3, 23, 30);
  rows = finishedDays(canary(first, now), now);
  assert.deepEqual(rows.map((r) => r.day), [dayKey(at(D0 + 2, 0))]);

  // After midnight its first hour has left the window: no row (an earlier run had it).
  now = at(D0 + 4, 0, 17);
  rows = finishedDays(canary(first, now), now);
  assert.deepEqual(rows.map((r) => r.day), [dayKey(at(D0 + 3, 0))]);
});

test('a stall, an hour without a bucket, and a canary that started mid-day', () => {
  const first = at(D0, 6, 30);
  const now = at(D0 + 1, 3);
  const c = canary(first, now, [[at(D0, 10, 50), at(D0, 12, 5)]]);
  const [row] = finishedDays(c, now);
  assert.equal(row.day, dayKey(at(D0, 0)));
  // 06:30 to 24:00 is 1050 ticks; the stall drops 75 of them, all of hour 11 included.
  assert.equal(row.ticks, 1050 - 75);
  assert.equal(row.missedMin, 75);
  assert.equal(row.maxGapMs, 76 * MIN);
  assert.equal(finishedDays({ status: { first: 0 } }, now).length, 0);
});

test('signing sample from the summary, or counted from the list', () => {
  assert.deepEqual(signingSample({ signing: 94, totalValidators: 1133 }), { signing: 94, total: 1133 });
  assert.deepEqual(signingSample({ validators: [{ status: 'signing' }, { status: 'idle' }] }), { signing: 1, total: 2 });
  assert.equal(signingSample(null), null);
  assert.equal(signingSample({ validators: [] }), null);
});

test('updateHistory upserts days, sums signing, merges stalls, keeps 90 days', () => {
  const first = at(D0, 0);
  let now = at(D0 + 1, 0, 17);
  const c1 = canary(first, now, [[at(D0, 5), at(D0, 5, 10)]]);
  let h = updateHistory(null, { snapshot: c1, part: { signing: 90, totalValidators: 100 }, now, canary: 'ase1x' });
  assert.equal(h.days.length, 1);
  assert.equal(h.incidents.length, 1);
  assert.deepEqual(h.signing, [{ day: dayKey(now), runs: 1, signing: 90, total: 100 }]);

  now = at(D0 + 1, 6, 17);
  const c2 = canary(first, now, [[at(D0, 5), at(D0, 5, 10)], [at(D0 + 1, 3), at(D0 + 1, 3, 4)]]);
  const again = updateHistory(h, { snapshot: c2, part: { signing: 80, totalValidators: 100 }, now, canary: 'ase1x' });
  assert.deepEqual(again.days, h.days, 'the same finished day, written again');
  assert.equal(again.incidents.length, 2, 'the old stall is not doubled');
  assert.deepEqual(again.signing, [{ day: dayKey(now), runs: 2, signing: 170, total: 200 }]);
  assert.equal(h.signing[0].runs, 1, 'the previous history is not changed in place');

  // 100 days later only the last 90 remain.
  const old = { ...again, days: Array.from({ length: 100 }, (_, i) => ({ day: dayKey(at(D0 - 99 + i, 0)), ticks: 1440, missedMin: 0 })) };
  now = at(D0 + 1, 12);
  h = updateHistory(old, { snapshot: c2, part: null, now, canary: 'ase1x' });
  assert.equal(h.days[0].day, dayKey(now - KEEP_DAYS * DAY));
  assert.equal(h.days[h.days.length - 1].day, dayKey(at(D0, 0)));
  assert.equal(h.days.length, KEEP_DAYS);
});

test('formatJson writes one item per line and parses back', () => {
  const h = { version: 1, days: [{ day: 'a' }, { day: 'b' }], names: { x: 'y' }, empty: [] };
  const text = formatJson(h);
  assert.deepEqual(JSON.parse(text), h);
  assert.equal(text.split('\n').length, 12);
});

test('mergeIncidents drops duplicates and sorts oldest first', () => {
  const a = { from: 3, to: 4 };
  const b = { from: 1, to: 2 };
  assert.deepEqual(mergeIncidents([a, b], [a], null), [b, a]);
});

test('daySlots: at least 14 slots, gaps stay empty, stalls and signing per day', () => {
  const now = at(D0 + 10, 9);
  const history = {
    days: [
      { day: dayKey(at(D0 + 7, 0)), missedMin: 0, blockMs: 2500 },
      { day: dayKey(at(D0 + 9, 0)), missedMin: 12, blockMs: 2600 },
    ],
    incidents: [{ from: at(D0 + 9, 4), to: at(D0 + 9, 4, 12), gap: 12 * MIN }],
    signing: [{ day: dayKey(at(D0 + 9, 0)), runs: 4, signing: 360, total: 400 }],
  };
  const slots = daySlots(history, now);
  assert.equal(slots.length, 14);
  const last = slots[slots.length - 1];
  assert.equal(last.day, dayKey(at(D0 + 9, 0)), 'yesterday is the newest slot');
  assert.equal(last.i, 13);
  assert.equal(last.stalls, 1);
  assert.equal(last.signing, 90);
  assert.equal(slots[12].row, null, 'a day the collector missed');
  assert.equal(slots[12].before, false);
  assert.equal(slots[11].row.blockMs, 2500);
  assert.equal(slots[10].before, true, 'before the history started');

  // Just after midnight UTC, before the next run, yesterday has no row yet.
  const early = daySlots(history, at(D0 + 11, 0, 5));
  assert.equal(early[early.length - 1].day, dayKey(at(D0 + 9, 0)));
  assert.deepEqual(daySlots({ days: [] }, now), []);
});
