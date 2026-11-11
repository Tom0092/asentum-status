// The status page's arithmetic: verdicts, uptime, hourly and daily rows,
// validator rows, number formats. No DOM and no globals, so it runs under
// node --test (test/page-logic.test.mjs) as well as in the browser. app.js draws
// with it; scripts/history-lib.mjs shares the day and stall helpers.
import { toAse1 } from './vendor/asentum-sdk.js';

export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 24 * HOUR;

// UTC day as 'YYYY-MM-DD'; Date.parse() reads it back as UTC midnight.
export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

const nf = new Intl.NumberFormat();
export const fmtInt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n)) : '–');
export const fmtSec = (ms, digits = 1) => `${(ms / 1000).toFixed(digits)} s`;

export function fmtDur(ms) {
  ms = Math.max(0, ms);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  // Round to whole minutes first, then split: 1 h 59.6 min is "2 h", not "1 h 60 min".
  const total = Math.round(ms / MIN);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtAgo(ms) {
  if (ms < 1500) return 'just now';
  return `${fmtDur(ms)} ago`;
}

export function canaryInterval(canary) {
  return Number(canary?.status?.intervalMs) || MIN;
}

// Seconds per block over the newest hour of canary ticks.
export function recentBlockTime(canary) {
  const r = canary?.recent || [];
  if (r.length < 2) return null;
  const last = r[r.length - 1];
  let first = r[0];
  for (const t of r) {
    if (last[0] - t[0] <= HOUR) {
      first = t;
      break;
    }
  }
  const blocks = last[1] - first[1];
  if (blocks <= 0) return null;
  return { ms: (last[0] - first[0]) / blocks, blocks, span: last[0] - first[0] };
}

// Remembers when this page last saw the final height move. A final block can be
// minutes old while finality still advances (it only lags), and that is not a stall.
export function nextFinality(seen, height, now) {
  if (!seen) return { height, at: now, moved: false };
  if (height > seen.height) return { height, at: now, moved: true };
  return seen;
}

// A single failed read must not flip the page to "unknown": the public RPC drops
// some requests when it is busy. The last good reading counts for this long.
export const STALE_MS = 90000;

export function verdict(state, now, host) {
  const failed = state.errors?.heads || state.errors?.chain;
  const silent = state.updatedAt ? now - state.updatedAt : Infinity;
  if (!state.heads || !state.chain || (failed && silent > STALE_MS)) {
    if (failed) {
      const msg = failed.message || 'no answer';
      const since = Number.isFinite(silent) ? ` for ${fmtDur(silent)}` : '';
      return {
        level: 'unknown',
        label: 'Unknown',
        title: "Can't reach the testnet from here",
        detail: `The RPC at ${host} has not answered${since} (${msg}). The chain may be fine; this page just can't see it right now.`,
      };
    }
    return { level: 'unknown', label: 'Checking', title: 'Checking the testnet…', detail: 'Reading the newest blocks and the canary contract.' };
  }
  const v = chainVerdict(state, now);
  if (failed) v.detail += ` The RPC at ${host} is dropping requests right now; this is the last good reading, ${fmtAgo(silent)}.`;
  return v;
}

export function chainVerdict(state, now) {
  const { tip, finalized } = state.heads;
  const lag = tip - finalized;
  const finalAge = Math.max(0, now - state.chain.timestamp);
  const last = Number(state.canary?.status?.last) || 0;
  const canaryAge = last ? Math.max(0, now - last) : null;
  const interval = canaryInterval(state.canary);

  const still = state.finalSeen ? now - state.finalSeen.at : 0;
  if (state.chain.timestamp && finalAge > 2 * MIN && still <= 2 * MIN) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'Finality is far behind',
      detail: `The newest final block, #${fmtInt(finalized)}, is ${fmtDur(finalAge)} old and ${fmtInt(lag)} blocks behind the newest block. ${state.finalSeen?.moved ? 'Finality still advances, only late.' : 'Watching whether it still advances.'}`,
    };
  }
  if (state.chain.timestamp && finalAge > 2 * MIN) {
    return {
      level: 'critical',
      label: 'Stalled',
      title: 'The testnet has stopped finalizing blocks',
      detail: `The newest final block, #${fmtInt(finalized)}, is ${fmtDur(finalAge)} old.${canaryAge !== null ? ` The canary last ticked ${fmtAgo(canaryAge)}.` : ''}`,
    };
  }
  if (lag > 30) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'Finality is falling behind',
      detail: `The newest block is ${fmtInt(lag)} blocks ahead of the newest final block. Transactions land, but take longer to become final.`,
    };
  }
  if (canaryAge !== null && canaryAge > 3 * interval) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'Blocks are final, but scheduled jobs are late',
      detail: `The canary last ticked ${fmtAgo(canaryAge)}. Either the chain is delaying cron jobs or the canary's gas escrow ran out.`,
    };
  }
  const parts = [`Newest final block #${fmtInt(finalized)}, ${fmtAgo(finalAge)}.`];
  if (canaryAge !== null) parts.push(`The canary ticked ${fmtAgo(canaryAge)}.`);
  return { level: 'good', label: 'Running', title: 'The testnet is running', detail: parts.join(' ') };
}

export function opStatus(op, now) {
  if (!op.last) return { key: 'waiting', level: 'neutral', label: 'Waiting for the first beat', rank: 2 };
  const age = now - op.last;
  const iv = (Number(op.interval) || 300) * 1000;
  if (age <= 2 * iv + MIN) return { key: 'ok', level: 'good', label: 'Online', rank: 3 };
  if (age <= 6 * iv) return { key: 'late', level: 'warning', label: 'Late', rank: 1 };
  return { key: 'offline', level: 'critical', label: 'Offline', rank: 0 };
}

// Per-hour uptime cells and the percentage over the shown window.
// A beat is only expected once a full interval has passed (the newest one may
// still be on its way), and the percentage compares window totals, so a beat
// that lands just after the hour turns does not count as a miss in one hour
// and a surplus in the next. Where the timer grid starts is unknown, so the
// percentage is good to about one beat: a single missed beat in 48 h can still
// read 100 %, the hour's cell still says "11 of 12".
export function opUptime(op, now, hours) {
  const iv = (Number(op.interval) || 300) * 1000;
  const endHour = Math.floor(now / HOUR);
  const startHour = endHour - hours + 1;
  const byHour = new Map((op.hist || []).map((b) => [b[0], b]));
  const joined = Number(op.joined) || 0;
  const due = now - iv;
  let got = 0;
  let want = 0;
  const cells = [];
  for (let h = startHour; h <= endHour; h++) {
    const from = Math.max(h * HOUR, joined);
    const beats = byHour.get(h)?.[1] || 0;
    if (Math.min((h + 1) * HOUR, now) <= from) {
      cells.push({ h, level: 'x', beats: 0, expected: 0, why: 'not registered yet' });
      continue;
    }
    const expected = Math.max(0, Math.floor((Math.min((h + 1) * HOUR, due) - from) / iv));
    got += beats;
    want += expected;
    if (!expected) {
      cells.push({ h, level: beats ? 3 : 'x', beats, expected, why: beats ? '' : 'too early to tell' });
      continue;
    }
    const frac = Math.min(1, beats / expected);
    cells.push({ h, level: frac >= 0.9 ? 3 : frac >= 0.5 ? 2 : frac > 0 ? 1 : 0, beats, expected });
  }
  return { pct: want ? (Math.min(got, want) / want) * 100 : null, cells };
}

export function opLatency(op) {
  let sum = 0;
  let n = 0;
  for (const b of op.hist || []) {
    sum += b[2];
    n += b[4];
  }
  return { last: op.lat >= 0 ? op.lat : null, avg: n ? sum / n : null };
}

// A y scale with round tick steps (1, 2, 2.5, 5 times a power of ten).
export function niceScale(v, floor, target = 4) {
  const m = Math.max(v, floor);
  const raw = m / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw - 1e-9);
  const ticks = Math.max(1, Math.ceil(m / step - 1e-9));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { max: ticks * step, ticks, fmt: (x) => (decimals ? x.toFixed(decimals) : fmtInt(x)) };
}

export function hourRows(canary, now) {
  const st = canary?.status;
  const buckets = canary?.buckets || [];
  if (!st || !st.first) return [];
  const interval = canaryInterval(canary);
  const byHour = new Map(buckets.map((b) => [b[0], b]));
  const endHour = Math.floor(now / HOUR);
  const rows = [];
  for (let h = endHour - 47; h <= endHour; h++) {
    const from = Math.max(h * HOUR, st.first);
    const to = Math.min((h + 1) * HOUR, now);
    if (to <= from) continue;
    const b = byHour.get(h);
    const ticks = b ? b[1] : 0;
    const partial = h === endHour || from > h * HOUR;
    const expected = Math.max(0, Math.floor((to - from) / interval) - (partial ? 1 : 0));
    const missedMin = (Math.max(0, expected - ticks) * interval) / MIN;
    rows.push({
      h,
      ticks,
      missedMin,
      maxGap: b ? b[2] : 0,
      blocks: b ? b[3] : 0,
      blockMs: b && b[3] > 0 ? b[4] / b[3] : null,
    });
  }
  return rows;
}

// Stalls from the canary (its newest 20) and from the daily history (90 days),
// oldest first. The same stall usually sits in both.
export function mergeIncidents(...lists) {
  const byFrom = new Map();
  for (const list of lists) {
    for (const x of list || []) if (x && Number.isFinite(x.from)) byFrom.set(x.from, x);
  }
  return [...byFrom.values()].sort((a, b) => a.from - b.from);
}

// "Last 90 days": one slot per UTC day, from the oldest collected day (at least
// 14 slots, at most 90) to the newest finished day. A day the collector missed
// has row: null; slots before the first collected day are marked `before`.
// Shortly after midnight UTC the collector has not run yet, so yesterday only
// gets a slot once it has a row or another day has passed.
export function daySlots(history, now) {
  const days = history?.days || [];
  if (!days.length) return [];
  const byDay = new Map(days.map((r) => [r.day, r]));
  const signing = new Map((history.signing || []).map((s) => [s.day, s]));
  const stalls = new Map();
  for (const x of history.incidents || []) {
    const k = dayKey(x.from);
    stalls.set(k, (stalls.get(k) || 0) + 1);
  }
  const first = Date.parse(days[0].day) / DAY;
  const newest = Date.parse(days[days.length - 1].day) / DAY;
  let end = Math.floor(now / DAY) - 1;
  if (newest === end - 1) end -= 1;
  const n = Math.min(90, Math.max(14, end - first + 1));
  const slots = [];
  for (let d = end - n + 1, i = 0; d <= end; d++, i++) {
    const day = dayKey(d * DAY);
    const s = signing.get(day);
    slots.push({
      i,
      day,
      before: d < first,
      row: byDay.get(day) || null,
      stalls: stalls.get(day) || 0,
      signing: s && s.runs ? s.signing / s.runs : null,
      total: s && s.runs ? s.total / s.runs : null,
    });
  }
  return slots;
}

export const RANK = { critical: 0, warning: 1, good: 2, neutral: 3 };

// Status from the validator's own signatures (node data, nothing to install).
export function signingStatus(v, live, state) {
  const p = state.part;
  // Without the participation list there is no way to tell; "not bonded" would be a guess.
  if (!v && !p) {
    return state.errors?.part
      ? { key: 'unknown', level: 'neutral', label: 'Signature data unavailable', sub: 'The node did not answer; retrying' }
      : { key: 'unknown', level: 'neutral', label: 'Loading signatures…', sub: '' };
  }
  if (!v) return { key: 'none', level: 'neutral', label: 'Not in the validator set', sub: 'This address is not bonded' };
  const misses = Number(live?.consecutiveMisses) || 0;
  const maxMisses = Number(state.live?.maxConsecutiveMisses) || 0;
  const pct = `${Math.round((Number(v.participationRatio) || 0) * 100)} % of the last ${fmtInt(p?.lookback || 1000)} blocks`;
  if (v.status === 'dormant') return { key: 'outside', level: 'neutral', label: 'Outside the committee', sub: 'Syncs, but signs nothing, so there is no signal' };
  if (maxMisses && misses >= maxMisses) return { key: 'problem', level: 'critical', label: 'Not voting', sub: `${fmtInt(misses)} votes missed in a row` };
  if (v.status === 'idle') return { key: 'problem', level: 'warning', label: 'Idle', sub: `No signature in the last ${fmtInt(p?.recentWindow || 100)} blocks` };
  if (misses > 0) return { key: 'problem', level: 'warning', label: 'Missing votes', sub: `${fmtInt(misses)} missed in a row, ${pct}` };
  if (v.status === 'signing') return { key: 'signing', level: 'good', label: 'Signing', sub: pct };
  return { key: 'other', level: 'neutral', label: String(v.status || 'Unknown'), sub: pct };
}

export function buildRows(state, now) {
  const ops = state.ops || [];
  const liveMap = new Map((state.live?.tracked || []).map((e) => [toAse1(e.address), e]));
  const opByValidator = new Map(ops.filter((o) => o.validator).map((o) => [toAse1(o.validator), o]));
  const rows = [];
  const placed = new Set();
  const make = (address, v, op) => {
    const sig = v || op?.validator ? signingStatus(v, v ? liveMap.get(address) : null, state) : null;
    const hb = op && Number(op.interval) > 0 ? opStatus(op, now) : null;
    const rank = Math.min(sig ? RANK[sig.level] : 9, hb ? RANK[hb.level] : 9);
    return { address, v, op, sig, hb, rank, stake: v ? BigInt(v.stake || '0') : 0n };
  };
  for (const v of state.part?.validators || []) {
    const a = toAse1(v.address);
    const op = opByValidator.get(a);
    if (op) placed.add(op.addr);
    rows.push(make(a, v, op));
  }
  for (const op of ops) {
    if (!placed.has(op.addr)) rows.push(make(op.validator ? toAse1(op.validator) : '', null, op));
  }
  return rows.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(Boolean(b.op)) - Number(Boolean(a.op)) ||
      (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0) ||
      (a.op?.name || a.address).localeCompare(b.op?.name || b.address),
  );
}

export const FILTERS = {
  all: () => true,
  problems: (r) => r.rank <= 1,
  signing: (r) => r.sig?.key === 'signing',
  outside: (r) => r.sig?.key === 'outside',
  named: (r) => Boolean(r.op),
};

// Where an offline node stopped, read from the chain. A stuck node can still call itself
// in sync and active (its tooling compares against a peer that may be stuck at the same
// height, 2026-10-29), so the page says it plainly when the network runs on without it.
export function stopHint(op, hb, tip, networkLevel) {
  // A stalled or unreadable network explains itself in the banner and the hero.
  if (networkLevel !== 'good' && networkLevel !== 'warning') return null;
  if (hb.key !== 'offline' || !op.lastBlock || !tip || tip <= op.lastBlock) return null;
  const fact = `Last beat landed in block #${fmtInt(op.lastBlock)}, the chain is ${fmtInt(tip - op.lastBlock)} blocks further.`;
  if (networkLevel !== 'good') return fact;
  return `${fact} The network is running, so check this node, even if it reports itself in sync.`;
}
