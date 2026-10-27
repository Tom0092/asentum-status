import { AsentumClient, toAse1, shortAse1 } from './vendor/asentum-sdk.js';
import CONFIG from './config.js';
import { createDemoSource } from './demo.js';

const MIN = 60000;
const HOUR = 3600000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- config

const params = new URLSearchParams(location.search);

function cleanUrl(value, fallback) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

const cfg = {
  rpc: cleanUrl(params.get('rpc') || CONFIG.rpc, CONFIG.rpc),
  explorer: cleanUrl(CONFIG.explorer || '', ''),
  registry: (params.get('registry') || CONFIG.registry || '').trim(),
  canary: (params.get('canary') || CONFIG.canary || '').trim(),
  repo: cleanUrl(CONFIG.repo || '', ''),
  demo: params.has('demo'),
};

// ---------------------------------------------------------------- data

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function chainSource() {
  const client = new AsentumClient(cfg.rpc, { retries: 2, requestTimeoutMs: 15000 });
  return {
    now: () => Date.now(),
    heads: () => client.getHeads(),
    async chainInfo() {
      const ci = await client.getChainInfo();
      return { height: ci.height, timestamp: Number(ci.latestHeader?.timestamp) || 0 };
    },
    async canary() {
      if (!cfg.canary) return null;
      return parseMaybeJson(await client.view(cfg.canary, 'snapshot', []));
    },
    async operators() {
      if (!cfg.registry) return null;
      const items = [];
      let offset = 0;
      let total = Infinity;
      while (offset < total && offset < 1000) {
        const page = parseMaybeJson(await client.view(cfg.registry, 'list', [offset, 100]));
        total = Number(page.total) || 0;
        if (!page.items || !page.items.length) break;
        items.push(...page.items);
        offset += page.items.length;
      }
      return items;
    },
    participation: () => client.getParticipation({ lookback: 1000 }),
  };
}

const source = cfg.demo ? createDemoSource() : chainSource();

const state = {
  heads: null,
  chain: null,
  canary: null,
  ops: null,
  part: null,
  errors: {},
  updatedAt: 0,
  loadedOnce: false,
};

// ---------------------------------------------------------------- format

const nf = new Intl.NumberFormat();
const fmtInt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n)) : '–');
const fmtSec = (ms, digits = 1) => `${(ms / 1000).toFixed(digits)} s`;

function fmtDur(ms) {
  ms = Math.max(0, ms);
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MIN);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtAgo(ms) {
  if (ms < 1500) return 'just now';
  return `${fmtDur(ms)} ago`;
}

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtClockSec = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function explorerLink(addr, text) {
  const a1 = toAse1(addr);
  if (!cfg.explorer) {
    const s = document.createElement('span');
    s.textContent = text || shortAse1(a1);
    return s;
  }
  const a = document.createElement('a');
  a.href = `${cfg.explorer}/address/${encodeURIComponent(a1)}`;
  a.rel = 'noopener';
  a.textContent = text || shortAse1(a1);
  a.title = a1;
  return a;
}

// ---------------------------------------------------------------- status icons

const ICONS = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="var(--good)"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7.2 13H.8z" fill="var(--warn)" stroke="var(--warn)" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="#17202b" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.9" r="1" fill="#17202b"/></svg>',
  critical: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1.8h5.8l4.1 4.1v5.8l-4.1 4.1H5.1L1 10.7V4.9z" fill="var(--crit)"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  neutral: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--muted)" stroke-width="1.6"/></svg>',
  unknown: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="var(--muted)"/></svg>',
};

function statusEl(level, label) {
  const span = document.createElement('span');
  span.className = 'status';
  span.innerHTML = ICONS[level] || ICONS.neutral; // constant markup only
  const text = document.createElement('span');
  text.textContent = label;
  span.append(text);
  return span;
}

// ---------------------------------------------------------------- derived data

function canaryInterval() {
  return Number(state.canary?.status?.intervalMs) || MIN;
}

// Seconds per block over the newest hour of canary ticks.
function recentBlockTime() {
  const r = state.canary?.recent || [];
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

function verdict(now) {
  const host = new URL(cfg.rpc).host;
  if (!state.heads || !state.chain) {
    if (state.errors.heads || state.errors.chain) {
      const msg = (state.errors.heads || state.errors.chain).message || 'no answer';
      return {
        level: 'unknown',
        label: 'Unknown',
        title: "Can't reach the testnet from here",
        detail: `The RPC at ${host} did not answer (${msg}). The chain may be fine; this page just can't see it right now.`,
      };
    }
    return { level: 'unknown', label: 'Checking', title: 'Checking the testnet…', detail: 'Reading the newest blocks and the canary contract.' };
  }
  const { tip, finalized } = state.heads;
  const lag = tip - finalized;
  const finalAge = Math.max(0, now - state.chain.timestamp);
  const last = Number(state.canary?.status?.last) || 0;
  const canaryAge = last ? Math.max(0, now - last) : null;
  const interval = canaryInterval();

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

function opStatus(op, now) {
  if (!op.last) return { key: 'waiting', level: 'neutral', label: 'Waiting', rank: 2 };
  const age = now - op.last;
  const iv = (Number(op.interval) || 300) * 1000;
  if (age <= 2 * iv + MIN) return { key: 'ok', level: 'good', label: 'Online', rank: 3 };
  if (age <= 6 * iv) return { key: 'late', level: 'warning', label: 'Late', rank: 1 };
  return { key: 'offline', level: 'critical', label: 'Offline', rank: 0 };
}

// Per-hour uptime cells and the percentage over the shown window.
function opUptime(op, now, hours) {
  const iv = (Number(op.interval) || 300) * 1000;
  const endHour = Math.floor(now / HOUR);
  const startHour = endHour - hours + 1;
  const byHour = new Map((op.hist || []).map((b) => [b[0], b]));
  const joined = Number(op.joined) || 0;
  let got = 0;
  let want = 0;
  const cells = [];
  for (let h = startHour; h <= endHour; h++) {
    const from = Math.max(h * HOUR, joined);
    const to = Math.min((h + 1) * HOUR, now);
    if (to <= from) {
      cells.push({ h, level: 'x', beats: 0, expected: 0 });
      continue;
    }
    const expected = Math.max(1, Math.floor((to - from) / iv));
    const beats = byHour.get(h)?.[1] || 0;
    const frac = Math.min(1, beats / expected);
    got += Math.min(beats, expected);
    want += expected;
    cells.push({ h, level: frac >= 0.9 ? 3 : frac >= 0.5 ? 2 : frac > 0 ? 1 : 0, beats, expected });
  }
  return { pct: want ? (got / want) * 100 : null, cells };
}

function opLatency(op) {
  let sum = 0;
  let n = 0;
  for (const b of op.hist || []) {
    sum += b[2];
    n += b[4];
  }
  return { last: op.lat >= 0 ? op.lat : null, avg: n ? sum / n : null };
}

// ---------------------------------------------------------------- svg helpers

function svgEl(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

function frame(box) {
  box.textContent = '';
  const w = Math.max(240, Math.floor(box.clientWidth));
  const h = Math.floor(box.clientHeight);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' });
  box.append(svg);
  return { svg, w, h };
}

// Bar with a 4px rounded data end and a square base.
function barPath(x, y, w, base) {
  const hgt = base - y;
  const r = Math.max(0, Math.min(4, w / 2, hgt));
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

// A y scale with round tick steps (1, 2, 2.5, 5 times a power of ten).
function niceScale(v, floor, target = 4) {
  const m = Math.max(v, floor);
  const raw = m / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw - 1e-9);
  const ticks = Math.max(1, Math.ceil(m / step - 1e-9));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { max: ticks * step, ticks, fmt: (x) => (decimals ? x.toFixed(decimals) : fmtInt(x)) };
}

function yGrid(svg, { left, right, top, base, max, ticks, fmt }) {
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = base - ((base - top) * i) / ticks;
    svgEl('line', { class: i === 0 ? 'baseline' : 'grid', x1: left, x2: right, y1: Math.round(y) + 0.5, y2: Math.round(y) + 0.5 }, svg);
    const t = svgEl('text', { class: 'axis-label', x: left - 6, y: y + 4, 'text-anchor': 'end' }, svg);
    t.textContent = fmt(v);
  }
}

function xLabels(svg, labels, y) {
  for (const { x, text, anchor } of labels) {
    const t = svgEl('text', { class: 'axis-label', x, y, 'text-anchor': anchor || 'middle' }, svg);
    t.textContent = text;
  }
}

function emptyMessage(box, text) {
  const { svg, w, h } = frame(box);
  svgEl('line', { class: 'baseline', x1: 0, x2: w, y1: h - 22.5, y2: h - 22.5 }, svg);
  const t = svgEl('text', { class: 'empty-msg', x: 0, y: h / 2 }, svg);
  t.textContent = text;
}

// ---------------------------------------------------------------- tooltip & hover

const tip = $('tooltip');

function showTip(lines, x, y) {
  tip.textContent = '';
  lines.forEach((line, i) => {
    const n = document.createElement(i === 0 ? 'strong' : 'span');
    n.textContent = line;
    tip.append(n);
  });
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 12;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (left < 8) left = 8;
  if (top < 8) top = y + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  tip.hidden = true;
}

// One hover/keyboard layer per chart: the reader aims at an x position,
// the nearest item is picked; arrow keys walk the items.
function attachHover(box, items, { xOf, describe, highlight }) {
  let active = -1;
  const svg = box.querySelector('svg');
  const set = (i, clientX, clientY) => {
    if (i < 0 || i >= items.length) return;
    active = i;
    highlight?.(i);
    const rect = svg.getBoundingClientRect();
    const px = clientX ?? rect.left + xOf(items[i]);
    const py = clientY ?? rect.top + rect.height / 3;
    showTip(describe(items[i]), px, py);
  };
  const clear = () => {
    active = -1;
    highlight?.(-1);
    hideTip();
  };
  const nearest = (clientX) => {
    const x = clientX - svg.getBoundingClientRect().left;
    let best = -1;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = Math.abs(xOf(it) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  box.onpointermove = (e) => {
    if (!items.length) return;
    set(nearest(e.clientX), e.clientX, e.clientY);
  };
  box.onpointerleave = clear;
  box.onblur = clear;
  box.onkeydown = (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = active < 0 ? items.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
      set(Math.max(0, Math.min(items.length - 1, next)));
    } else if (e.key === 'Escape') {
      clear();
    }
  };
}

function fillTable(id, head, rows) {
  const host = $(id);
  host.textContent = '';
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = table.createTHead().insertRow();
  head.forEach(([label, num]) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (num) th.className = 'num';
    thead.append(th);
  });
  const tbody = table.createTBody();
  for (const row of rows) {
    const tr = tbody.insertRow();
    row.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (head[i][1]) td.className = 'num';
    });
  }
  if (!rows.length) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = head.length;
    td.textContent = 'No data yet.';
  }
  host.append(table);
}

// ---------------------------------------------------------------- charts

let lastAnimatedTick = 0;

function renderPulse(now) {
  const box = $('pulse');
  const recent = state.canary?.recent || [];
  const windowMin = box.clientWidth < 560 ? 60 : 120;
  $('pulse').setAttribute('aria-label', `Blocks per minute, last ${windowMin === 60 ? 'hour' : 'two hours'}`);

  if (!cfg.canary && !cfg.demo) {
    emptyMessage(box, 'No canary contract configured yet.');
    fillTable('pulse-table', [['Time'], ['Blocks', 1], ['Gap', 1], ['Blocks per minute', 1]], []);
    return;
  }
  if (recent.length < 2) {
    emptyMessage(box, state.canary ? 'Waiting for the first canary ticks.' : 'Loading…');
    return;
  }

  const interval = canaryInterval();
  const slotOf = (t) => windowMin - 1 - Math.floor((now - t) / MIN);
  const bars = [];
  const misses = new Set();
  for (let i = 1; i < recent.length; i++) {
    const [t, b] = recent[i];
    const [pt, pb] = recent[i - 1];
    const gap = t - pt;
    const blocks = b - pb;
    const s = slotOf(t);
    if (gap > 1.5 * interval) for (let m = slotOf(pt) + 1; m < s; m++) if (m >= 0) misses.add(m);
    if (s >= 0 && s < windowMin) bars.push({ s, t, gap, blocks, rate: gap > 0 ? (blocks * MIN) / gap : 0 });
  }
  const lastT = recent[recent.length - 1][0];
  if (now - lastT > 1.5 * interval) for (let m = slotOf(lastT) + 1; m <= windowMin - 1; m++) if (m >= 0) misses.add(m);

  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 30;
  const top = 12;
  const base = h - 24;
  const slotW = (right - left) / windowMin;
  const bw = Math.max(2, Math.min(24, slotW - 2));
  const scale = niceScale(Math.max(...bars.map((b) => b.rate), 0) * 1.1, 30, 3);
  const max = scale.max;
  const yOf = (v) => base - (v / max) * (base - top);
  const xOf = (s) => left + s * slotW + (slotW - bw) / 2;

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(
    svg,
    windowMin === 120
      ? [
          { x: left, text: '2 h ago', anchor: 'start' },
          { x: left + (right - left) / 2, text: '1 h ago' },
          { x: right, text: 'now', anchor: 'end' },
        ]
      : [
          { x: left, text: '1 h ago', anchor: 'start' },
          { x: left + (right - left) / 2, text: '30 min ago' },
          { x: right, text: 'now', anchor: 'end' },
        ],
    h - 6,
  );

  const items = [];
  const nodes = [];
  for (const s of [...misses].sort((a, b) => a - b)) {
    const node = svgEl('rect', { class: 'miss', x: xOf(s), y: base - 6, width: bw, height: 6, rx: 1 }, svg);
    items.push({ kind: 'miss', s, t: now - (windowMin - 1 - s) * MIN });
    nodes.push(node);
  }
  for (const b of bars) {
    const node = svgEl('path', { class: 'bar', d: barPath(xOf(b.s), yOf(b.rate), bw, base) }, svg);
    if (b.t === lastT && lastT !== lastAnimatedTick && state.loadedOnce) node.classList.add('grow');
    items.push({ kind: 'bar', ...b });
    nodes.push(node);
  }
  lastAnimatedTick = lastT;

  const newest = bars[bars.length - 1];
  if (newest) {
    const t = svgEl('text', { class: 'end-label', x: Math.min(xOf(newest.s) + bw + 4, w - 2), y: yOf(newest.rate) + 4 }, svg);
    t.textContent = fmtInt(newest.rate);
  }

  const order = items.map((it, i) => [it, nodes[i]]).sort((a, b) => a[0].s - b[0].s);
  attachHover(box, order.map((o) => o[0]), {
    xOf: (it) => xOf(it.s) + bw / 2,
    highlight: (i) => order.forEach(([, n], j) => n.classList.toggle('is-active', j === i)),
    describe: (it) =>
      it.kind === 'miss'
        ? ['No tick', `Minute around ${fmtClock(it.t)}`, 'The chain ran no scheduled job here.']
        : [`${fmtInt(it.rate)} blocks per minute`, `Tick at ${fmtClockSec(it.t)}`, `${fmtInt(it.blocks)} blocks in ${fmtSec(it.gap, 0)} since the previous tick`],
  });

  fillTable(
    'pulse-table',
    [['Tick time'], ['Blocks', 1], ['Gap', 1], ['Blocks per minute', 1]],
    [...bars].reverse().map((b) => [fmtClockSec(b.t), fmtInt(b.blocks), fmtSec(b.gap, 0), fmtInt(b.rate)]),
  );
}

function hourRows(now) {
  const st = state.canary?.status;
  const buckets = state.canary?.buckets || [];
  if (!st || !st.first) return [];
  const interval = canaryInterval();
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

function renderMissed(now) {
  const box = $('missed');
  const rows = hourRows(now);
  if (!rows.length) {
    emptyMessage(box, state.canary ? 'No canary history yet.' : cfg.canary || cfg.demo ? 'Loading…' : 'No canary contract configured yet.');
    fillTable('missed-table', [['Hour'], ['Minutes without a tick', 1], ['Longest gap', 1]], []);
    return;
  }
  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 4;
  const top = 12;
  const base = h - 24;
  const endHour = Math.floor(now / HOUR);
  const slotW = (right - left) / 48;
  const bw = Math.max(2, Math.min(24, slotW - 2));
  const xOf = (hr) => left + (hr - (endHour - 47)) * slotW + (slotW - bw) / 2;
  const scale = niceScale(Math.max(...rows.map((r) => r.missedMin)), 5, 3);
  const max = scale.max;
  const yOf = (v) => base - (v / max) * (base - top);

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(
    svg,
    [
      { x: left, text: '48 h ago', anchor: 'start' },
      { x: left + (right - left) / 2, text: '24 h ago' },
      { x: right, text: 'now', anchor: 'end' },
    ],
    h - 6,
  );

  const nodes = rows.map((r) =>
    r.missedMin > 0 ? svgEl('path', { class: 'bar', d: barPath(xOf(r.h), yOf(r.missedMin), bw, base) }, svg) : null,
  );
  attachHover(box, rows, {
    xOf: (r) => xOf(r.h) + bw / 2,
    highlight: (i) => nodes.forEach((n, j) => n?.classList.toggle('is-active', j === i)),
    describe: (r) => [
      r.missedMin > 0 ? `${fmtInt(r.missedMin)} min without a tick` : 'No missed minutes',
      `${fmtClock(r.h * HOUR)} to ${fmtClock((r.h + 1) * HOUR)}`,
      r.ticks ? `${fmtInt(r.ticks)} ticks, longest gap ${fmtDur(r.maxGap)}` : 'No ticks this hour',
    ],
  });
  fillTable(
    'missed-table',
    [['Hour'], ['Minutes without a tick', 1], ['Ticks', 1], ['Longest gap', 1]],
    [...rows].reverse().map((r) => [fmtDay(r.h * HOUR), fmtInt(r.missedMin), fmtInt(r.ticks), r.ticks ? fmtDur(r.maxGap) : '–']),
  );
}

function renderBlockTime(now) {
  const box = $('blocktime');
  const rows = hourRows(now).filter((r) => r.blockMs !== null);
  if (rows.length < 2) {
    emptyMessage(box, state.canary ? 'Not enough canary history yet.' : cfg.canary || cfg.demo ? 'Loading…' : 'No canary contract configured yet.');
    fillTable('blocktime-table', [['Hour'], ['Seconds per block', 1], ['Blocks', 1]], []);
    return;
  }
  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 44;
  const top = 12;
  const base = h - 24;
  const endHour = Math.floor(now / HOUR);
  const slotW = (right - left) / 48;
  const xOf = (hr) => left + (hr - (endHour - 47)) * slotW + slotW / 2;
  const scale = niceScale(Math.max(...rows.map((r) => r.blockMs / 1000)) * 1.15, 3, 4);
  const max = scale.max;
  const yOf = (v) => base - (v / max) * (base - top);

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(
    svg,
    [
      { x: left, text: '48 h ago', anchor: 'start' },
      { x: left + (right - left) / 2, text: '24 h ago' },
      { x: right, text: 'now', anchor: 'end' },
    ],
    h - 6,
  );

  // Break the line where an hour has no data.
  const segments = [];
  let seg = [];
  rows.forEach((r, i) => {
    if (i > 0 && r.h !== rows[i - 1].h + 1) {
      segments.push(seg);
      seg = [];
    }
    seg.push(r);
  });
  segments.push(seg);
  for (const s of segments) {
    if (s.length === 1) {
      svgEl('circle', { class: 'dot', cx: xOf(s[0].h), cy: yOf(s[0].blockMs / 1000), r: 3 }, svg);
      continue;
    }
    const pts = s.map((r) => `${xOf(r.h).toFixed(1)},${yOf(r.blockMs / 1000).toFixed(1)}`);
    svgEl('path', { class: 'area', d: `M${xOf(s[0].h)},${base}L${pts.join('L')}L${xOf(s[s.length - 1].h)},${base}Z` }, svg);
    svgEl('path', { class: 'line', d: `M${pts.join('L')}` }, svg);
  }
  const lastRow = rows[rows.length - 1];
  svgEl('circle', { class: 'dot', cx: xOf(lastRow.h), cy: yOf(lastRow.blockMs / 1000), r: 4 }, svg);
  const lbl = svgEl('text', { class: 'end-label', x: xOf(lastRow.h) + 8, y: yOf(lastRow.blockMs / 1000) + 4 }, svg);
  lbl.textContent = fmtSec(lastRow.blockMs, 2);

  const cursor = svgEl('line', { class: 'cursor', x1: 0, x2: 0, y1: top, y2: base, visibility: 'hidden' }, svg);
  const marker = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' }, svg);
  attachHover(box, rows, {
    xOf: (r) => xOf(r.h),
    highlight: (i) => {
      const vis = i < 0 ? 'hidden' : 'visible';
      cursor.setAttribute('visibility', vis);
      marker.setAttribute('visibility', vis);
      if (i < 0) return;
      const x = Math.round(xOf(rows[i].h)) + 0.5;
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
      marker.setAttribute('cx', xOf(rows[i].h));
      marker.setAttribute('cy', yOf(rows[i].blockMs / 1000));
    },
    describe: (r) => [`${fmtSec(r.blockMs, 2)} per block`, `${fmtClock(r.h * HOUR)} to ${fmtClock((r.h + 1) * HOUR)}`, `${fmtInt(r.blocks)} blocks`],
  });
  fillTable(
    'blocktime-table',
    [['Hour'], ['Seconds per block', 1], ['Blocks', 1]],
    [...rows].reverse().map((r) => [fmtDay(r.h * HOUR), (r.blockMs / 1000).toFixed(2), fmtInt(r.blocks)]),
  );
}

function renderIncidents() {
  const list = $('incidents');
  list.textContent = '';
  const inc = [...(state.canary?.incidents || [])].reverse();
  if (!inc.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = state.canary ? 'No stalls of three minutes or more on record.' : 'No canary data yet.';
    list.append(li);
    return;
  }
  for (const x of inc) {
    const li = document.createElement('li');
    const gap = document.createElement('span');
    gap.className = 'gap';
    gap.textContent = fmtDur(x.gap);
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${fmtDay(x.from)} to ${fmtClock(x.to)}, blocks ${fmtInt(x.fromBlock)} to ${fmtInt(x.toBlock)}`;
    li.append(gap, when);
    list.append(li);
  }
}

// ---------------------------------------------------------------- hero & kpis

function renderHero(now) {
  const v = verdict(now);
  const hero = $('hero');
  hero.setAttribute('aria-busy', v.label === 'Checking' ? 'true' : 'false');
  const st = $('state');
  st.querySelector('.state-icon').innerHTML = ICONS[v.level] || ICONS.unknown; // constant markup
  st.querySelector('.state-label').textContent = v.label;
  $('verdict').textContent = v.title;
  $('verdict-detail').textContent = v.detail;
  document.title = `${v.label}: Asentum testnet status`;
  return v;
}

function renderKpis(now) {
  const h = state.heads;
  const c = state.chain;
  $('kpi-tip').textContent = h ? fmtInt(h.tip) : '–';
  $('kpi-tip-sub').textContent = h && c ? `Final #${fmtInt(h.finalized)}, ${fmtAgo(Math.max(0, now - c.timestamp))}` : '';

  const bt = recentBlockTime();
  if (h) {
    const lag = h.tip - h.finalized;
    $('kpi-lag').textContent = `${fmtInt(lag)} ${lag === 1 ? 'block' : 'blocks'}`;
    $('kpi-lag-sub').textContent = bt ? `About ${fmtDur(lag * bt.ms)} until a new block is final` : 'Tip minus newest final block';
  } else {
    $('kpi-lag').textContent = '–';
    $('kpi-lag-sub').textContent = '';
  }

  $('kpi-bt').textContent = bt ? fmtSec(bt.ms, 2) : '–';
  $('kpi-bt-sub').textContent = bt ? `${fmtInt(bt.blocks)} blocks in ${fmtDur(bt.span)}` : cfg.canary || cfg.demo ? '' : 'Needs the canary';

  const p = state.part;
  if (p && p.totalValidators) {
    $('kpi-val').textContent = `${fmtInt(p.signing)} of ${fmtInt(p.totalValidators)}`;
    $('kpi-val-sub').textContent = `${fmtInt(p.idle)} idle, ${fmtInt(p.dormant)} dormant in the last ${fmtInt(p.lookback)} blocks`;
  } else {
    $('kpi-val').textContent = '–';
    $('kpi-val-sub').textContent = state.errors.part ? 'Participation data unavailable' : '';
  }
}

// ---------------------------------------------------------------- operators

let filter = 'all';
let query = '';

function renderOperators(now, networkLevel) {
  const body = $('op-body');
  const empty = $('op-empty');
  const banner = $('op-banner');
  body.textContent = '';

  banner.hidden = networkLevel !== 'critical';
  banner.textContent = 'The network itself is stalled, so no heartbeat can land. Late or offline operators below reflect that, not their nodes.';

  if (!cfg.registry && !cfg.demo) {
    empty.hidden = false;
    empty.textContent = 'No heartbeat registry configured yet.';
    return;
  }
  if (!state.ops) {
    empty.hidden = false;
    empty.textContent = state.errors.ops ? `Couldn't load operators: ${state.errors.ops.message}` : 'Loading operators…';
    return;
  }

  const narrow = window.matchMedia('(max-width: 760px)').matches;
  const hours = narrow ? 24 : 48;
  const partMap = new Map((state.part?.validators || []).map((v) => [toAse1(v.address), v]));
  const rows = state.ops.map((op) => ({ op, st: opStatus(op, now) }));
  const counts = { all: rows.length, ok: 0, late: 0, offline: 0 };
  rows.forEach((r) => {
    if (r.st.key in counts) counts[r.st.key] += 1;
  });
  document.querySelectorAll('[data-count]').forEach((n) => {
    n.textContent = fmtInt(counts[n.dataset.count] || 0);
  });

  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((r) => filter === 'all' || r.st.key === filter)
    .filter((r) => !q || r.op.name.includes(q) || toAse1(r.op.addr).includes(q) || r.op.addr.includes(q))
    .sort((a, b) => a.st.rank - b.st.rank || a.op.name.localeCompare(b.op.name));

  empty.hidden = shown.length > 0;
  if (!rows.length) {
    empty.textContent = 'No operators yet. Add your node with the steps below; it takes about ten minutes.';
  } else if (!shown.length) {
    empty.textContent = 'No operator matches this filter.';
  }

  for (const { op, st } of shown) {
    const tr = body.insertRow();

    const name = tr.insertCell();
    name.className = 'c-name';
    const nm = document.createElement('span');
    nm.className = 'op-name';
    nm.textContent = op.name;
    const addr = explorerLink(op.addr);
    addr.classList.add('op-addr');
    name.append(nm, addr);

    const status = tr.insertCell();
    status.className = 'c-status';
    status.append(statusEl(st.level, st.label));

    const last = tr.insertCell();
    last.dataset.label = 'Last heartbeat';
    if (op.last) {
      last.textContent = fmtAgo(now - op.last);
      const sub = document.createElement('span');
      sub.className = 'op-sub';
      sub.textContent = `every ${fmtDur(op.interval * 1000)}, ${fmtInt(op.beats)} so far`;
      last.append(sub);
    } else {
      last.textContent = 'None yet';
    }

    const lat = tr.insertCell();
    lat.className = 'num';
    lat.dataset.label = 'Latency';
    const L = opLatency(op);
    lat.textContent = L.last !== null ? fmtSec(L.last) : '–';
    if (L.avg !== null) {
      const sub = document.createElement('span');
      sub.className = 'op-sub';
      sub.textContent = `avg ${fmtSec(L.avg)}`;
      lat.append(sub);
    }

    const up = tr.insertCell();
    up.className = 'c-uptime';
    up.dataset.label = `Uptime, ${hours} h`;
    const U = opUptime(op, now, hours);
    const wrap = document.createElement('div');
    wrap.className = 'uptime';
    const pct = document.createElement('span');
    pct.className = 'uptime-pct';
    pct.textContent = U.pct === null || !op.last ? '–' : `${U.pct >= 99.95 ? '100' : U.pct.toFixed(1)} %`;
    const cells = document.createElement('div');
    cells.className = 'cells';
    cells.setAttribute('role', 'img');
    cells.setAttribute('aria-label', `Heartbeats per hour, last ${hours} hours`);
    for (const c of U.cells) {
      const s = document.createElement('span');
      s.dataset.l = String(c.level);
      s.title = c.level === 'x' ? `${fmtClock(c.h * HOUR)}: not registered yet` : `${fmtClock(c.h * HOUR)}: ${c.beats} of ${c.expected} heartbeats`;
      cells.append(s);
    }
    wrap.append(pct, cells);
    up.append(wrap);

    const val = tr.insertCell();
    val.className = 'c-val';
    val.dataset.label = 'Validator';
    if (op.validator) {
      const entry = partMap.get(toAse1(op.validator));
      if (entry) {
        const lvl = entry.status === 'signing' ? 'good' : entry.status === 'idle' ? 'warning' : 'critical';
        val.append(statusEl(lvl, entry.status === 'signing' ? 'Signing' : entry.status === 'idle' ? 'Idle' : 'Dormant'));
        const sub = document.createElement('span');
        sub.className = 'op-sub';
        sub.textContent = `${Math.round((entry.participationRatio || 0) * 100)} % of recent blocks, `;
        sub.append(explorerLink(op.validator));
        val.append(sub);
      } else {
        val.append(statusEl('neutral', state.part ? 'Not in the validator set' : 'Checking'));
        const sub = document.createElement('span');
        sub.className = 'op-sub';
        sub.append(explorerLink(op.validator));
        val.append(sub);
      }
    } else {
      val.textContent = '–';
    }
  }
}

// ---------------------------------------------------------------- page chrome

function renderChrome() {
  const links = $('foot-links');
  links.textContent = '';
  const add = (label, node) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = `${label} `;
    li.append(s, node);
    links.append(li);
  };
  if (cfg.registry) add('Heartbeat registry', explorerLink(cfg.registry));
  if (cfg.canary) add('Canary', explorerLink(cfg.canary));
  const rpc = document.createElement('span');
  rpc.textContent = new URL(cfg.rpc).host;
  add('Data from', rpc);
  if (cfg.repo) {
    const a = document.createElement('a');
    a.href = cfg.repo;
    a.rel = 'noopener';
    a.textContent = 'GitHub';
    add('Source on', a);
    $('repo-url').textContent = `${cfg.repo}.git`;
  }
}

function renderUpdated(now) {
  const el = $('updated');
  const failing = Object.keys(state.errors).filter((k) => state.errors[k]);
  if (!state.updatedAt) {
    el.textContent = failing.length ? 'Testnet not reachable. Retrying…' : 'Connecting to the testnet…';
    return;
  }
  const base = cfg.demo ? 'Demo data, not the live testnet. ' : '';
  const age = fmtAgo(now - state.updatedAt);
  el.textContent = `${base}Updated ${age}${failing.length ? `, some data failed to load` : ''}`;
}

function renderAll() {
  const now = source.now();
  const v = renderHero(now);
  renderKpis(now);
  renderPulse(now);
  renderMissed(now);
  renderBlockTime(now);
  renderIncidents();
  renderOperators(now, v.level);
  renderUpdated(now);
}

// ---------------------------------------------------------------- polling

const FAST_MS = 10000;
let round = 0;
let timer = null;

async function load(key, fn) {
  try {
    state[key] = await fn();
    state.errors[key] = null;
  } catch (e) {
    state.errors[key] = e;
    // Without fresh heads the page must not guess: show "unknown", not "stalled".
    if (key === 'heads' || key === 'chain') state[key] = null;
  }
}

async function poll() {
  clearTimeout(timer);
  const jobs = [load('heads', source.heads), load('chain', source.chainInfo), load('canary', source.canary)];
  if (round % 3 === 0) jobs.push(load('ops', source.operators));
  if (round % 12 === 0) jobs.push(load('part', source.participation));
  round += 1;
  document.querySelectorAll('.plot').forEach((p) => p.classList.add('refreshing'));
  await Promise.allSettled(jobs);
  document.querySelectorAll('.plot').forEach((p) => p.classList.remove('refreshing'));
  if (!state.errors.heads && !state.errors.chain) state.updatedAt = source.now();
  renderAll();
  state.loadedOnce = true;
  if (!document.hidden) timer = setTimeout(poll, FAST_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else poll();
});

setInterval(() => {
  if (!document.hidden) renderUpdated(source.now());
}, 1000);

// ---------------------------------------------------------------- controls

$('filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  filter = btn.dataset.filter;
  document.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  renderOperators(source.now(), verdict(source.now()).level);
});

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  renderOperators(source.now(), verdict(source.now()).level);
});

const root = document.documentElement;
const themeBtn = $('theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => root.dataset.theme || (prefersDark.matches ? 'dark' : 'light');
const syncThemeButton = () => {
  themeBtn.textContent = currentTheme() === 'dark' ? 'Light' : 'Dark';
};
try {
  const saved = localStorage.getItem('asentum-status-theme');
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
} catch {
  /* storage unavailable */
}
syncThemeButton();
themeBtn.addEventListener('click', () => {
  root.dataset.theme = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('asentum-status-theme', root.dataset.theme);
  } catch {
    /* storage unavailable */
  }
  syncThemeButton();
});
prefersDark.addEventListener('change', syncThemeButton);

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (state.loadedOnce) renderAll();
  });
}).observe(document.querySelector('main'));

renderChrome();
renderAll();
poll();
