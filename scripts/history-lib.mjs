// The daily history behind the page's "Last 90 days". The canary keeps only
// 48 hourly buckets and its newest 20 stalls; scripts/collect.mjs runs every six
// hours and folds them into one row per finished UTC day. Pure functions, so
// test/history.test.mjs can check them without a node.
import { MIN, HOUR, DAY, dayKey, mergeIncidents } from '../site/logic.js';

export const KEEP_DAYS = 90;

// One row per UTC day that has ended and whose 24 hours are all still in the
// canary's bucket window. The canary keeps the 48 hours up to its newest tick,
// so a day stays readable until midnight UTC the next day: a collector that
// misses runs for up to a day loses nothing.
// An hour without a bucket had no tick at all.
export function finishedDays(snapshot, now) {
  const st = snapshot?.status;
  if (!st || !st.first) return [];
  const interval = Number(st.intervalMs) || MIN;
  const keep = Number(st.keepHours) || 48;
  const byHour = new Map((snapshot.buckets || []).map((b) => [b[0], b]));
  const oldestHour = Math.floor(now / HOUR) - keep + 1;
  const rows = [];
  for (let d = Math.floor(now / DAY) - 1; d * 24 >= oldestHour && (d + 1) * DAY > st.first; d--) {
    let ticks = 0;
    let missed = 0;
    let maxGap = 0;
    let blocks = 0;
    let ms = 0;
    for (let h = d * 24; h < d * 24 + 24; h++) {
      const from = Math.max(h * HOUR, st.first);
      const to = (h + 1) * HOUR;
      if (to <= from) continue;
      // Same rule as the page's hourly chart: an hour the canary started in
      // expects one tick less.
      const expected = Math.max(0, Math.floor((to - from) / interval) - (from > h * HOUR ? 1 : 0));
      const b = byHour.get(h);
      const n = b ? b[1] : 0;
      missed += Math.max(0, expected - n);
      if (b) {
        ticks += n;
        maxGap = Math.max(maxGap, b[2]);
        blocks += b[3];
        ms += b[4];
      }
    }
    rows.push({
      day: dayKey(d * DAY),
      ticks,
      missedMin: (missed * interval) / MIN,
      maxGapMs: maxGap,
      blocks,
      blockMs: blocks ? Math.round((ms / blocks) * 10) / 10 : null,
    });
  }
  return rows.reverse();
}

// Validators signing, from the node's participation summary: summed per UTC
// day, so the page can show the daily average.
export function signingSample(part) {
  if (!part) return null;
  const vs = Array.isArray(part.validators) ? part.validators : [];
  const total = Number(part.totalValidators ?? vs.length);
  const signing = Number(part.signing ?? vs.filter((v) => v.status === 'signing').length);
  if (!Number.isFinite(total) || !Number.isFinite(signing) || total <= 0) return null;
  return { signing, total };
}

export function emptyHistory() {
  return { version: 1, updated: 0, canary: '', intervalMs: MIN, days: [], incidents: [], signing: [] };
}

// Fold one reading into the history. Running twice with the same reading
// changes nothing but `updated`; a finished day is simply written again.
export function updateHistory(prev, { snapshot, part, now, canary }) {
  const h = prev && prev.version === 1 ? prev : emptyHistory();
  const days = new Map((h.days || []).map((r) => [r.day, r]));
  for (const r of finishedDays(snapshot, now)) days.set(r.day, r);

  const signing = new Map((h.signing || []).map((s) => [s.day, { ...s }]));
  const sample = signingSample(part);
  if (sample) {
    const k = dayKey(now);
    const s = signing.get(k) || { day: k, runs: 0, signing: 0, total: 0 };
    s.runs += 1;
    s.signing += sample.signing;
    s.total += sample.total;
    signing.set(k, s);
  }

  const cutoff = dayKey(now - KEEP_DAYS * DAY);
  const cutoffMs = Date.parse(cutoff);
  const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  return {
    version: 1,
    updated: now,
    canary: canary || h.canary || '',
    intervalMs: Number(snapshot?.status?.intervalMs) || h.intervalMs || MIN,
    days: [...days.values()].filter((r) => r.day >= cutoff).sort(byDay),
    incidents: mergeIncidents(h.incidents, snapshot?.incidents).filter((x) => x.from >= cutoffMs),
    signing: [...signing.values()].filter((s) => s.day >= cutoff).sort(byDay),
  };
}

// JSON with one array item or object entry per line, so the commits on the
// data branch show which day changed.
export function formatJson(obj) {
  const lines = Object.entries(obj).map(([k, v]) => {
    const key = `  ${JSON.stringify(k)}: `;
    if (Array.isArray(v) && v.length) {
      return `${key}[\n${v.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      return `${key}{\n${Object.entries(v).map(([a, b]) => `    ${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(',\n')}\n  }`;
    }
    return key + JSON.stringify(v);
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}
