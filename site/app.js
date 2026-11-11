import { AsentumClient, toAse1, shortAse1, formatAse } from './vendor/asentum-sdk.js';
import CONFIG from './config.js';
import { createDemoSource } from './demo.js';
import {
  MIN,
  HOUR,
  fmtInt,
  fmtSec,
  fmtDur,
  fmtAgo,
  canaryInterval,
  recentBlockTime,
  nextFinality,
  verdict,
  opUptime,
  opLatency,
  niceScale,
  hourRows,
  DAY,
  daySlots,
  mergeIncidents,
  buildRows,
  nameView,
  matchesQuery,
  stopHint,
  FILTERS,
} from './logic.js';

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
const rpcHost = new URL(cfg.rpc).host;

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
  // No retries: the next poll is the retry, and poll() backs off while the RPC fails.
  const client = new AsentumClient(cfg.rpc, { retries: 0, requestTimeoutMs: 15000 });
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
    liveness: () => client.getLiveness(),
    // Written next to the page by the Pages workflow (scripts/collect.mjs).
    // It describes the configured canary only, not one given in the URL.
    async history() {
      const r = await fetch('history.json', { cache: 'no-cache' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`history.json: HTTP ${r.status}`);
      const h = await r.json();
      return h.canary === cfg.canary ? h : null;
    },
    // Primary @names of validators, also from the Pages workflow. They
    // belong to the configured network, not to one given in the URL.
    async names() {
      const r = await fetch('names.json', { cache: 'no-cache' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`names.json: HTTP ${r.status}`);
      const n = await r.json();
      return n.rpc === cfg.rpc ? n.names : null;
    },
  };
}

const source = cfg.demo ? createDemoSource() : chainSource();

const state = {
  heads: null,
  chain: null,
  canary: null,
  ops: null,
  part: null,
  live: null,
  history: null,
  names: null,
  finalSeen: null,
  errors: {},
  updatedAt: 0,
  loadedOnce: false,
};

// ---------------------------------------------------------------- format

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtClockSec = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// A UTC day ('YYYY-MM-DD') from the daily history.
const fmtDate = (key) => new Date(Date.parse(key)).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });

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

// A plain check, unlike the status icons, so it does not read as "signing".
const ONCHAIN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8.6l3.4 3.3 7-7.6" fill="none" stroke="var(--series)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function statusEl(level, label) {
  const span = document.createElement('span');
  span.className = 'status';
  span.innerHTML = ICONS[level] || ICONS.neutral; // constant markup only
  const text = document.createElement('span');
  text.textContent = label;
  span.append(text);
  return span;
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

  const interval = canaryInterval(state.canary);
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

// Bars on a grid of `slots` columns; each item names its column in `i`.
function barChart(box, items, { slots, value, floor, labels, describe }) {
  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 4;
  const top = 12;
  const base = h - 24;
  const slotW = (right - left) / slots;
  const bw = Math.max(2, Math.min(24, slotW - 2));
  const xOf = (i) => left + i * slotW + (slotW - bw) / 2;
  const scale = niceScale(Math.max(...items.map(value)), floor, 3);
  const yOf = (v) => base - (v / scale.max) * (base - top);

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(svg, labels(left, right), h - 6);

  const nodes = items.map((it) =>
    value(it) > 0 ? svgEl('path', { class: 'bar', d: barPath(xOf(it.i), yOf(value(it)), bw, base) }, svg) : null,
  );
  attachHover(box, items, {
    xOf: (it) => xOf(it.i) + bw / 2,
    highlight: (k) => nodes.forEach((n, j) => n?.classList.toggle('is-active', j === k)),
    describe,
  });
  return { svg, xOf, bw, base };
}

// A line over a grid of `slots` columns, broken where a column has no item.
function lineChart(box, items, { slots, value, floor, labels, describe, endLabel }) {
  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 44;
  const top = 12;
  const base = h - 24;
  const slotW = (right - left) / slots;
  const xOf = (it) => left + it.i * slotW + slotW / 2;
  const scale = niceScale(Math.max(...items.map(value)) * 1.15, floor, 4);
  const yOf = (v) => base - (v / scale.max) * (base - top);

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(svg, labels(left, right), h - 6);

  const segments = [];
  let seg = [];
  items.forEach((it, k) => {
    if (k > 0 && it.i !== items[k - 1].i + 1) {
      segments.push(seg);
      seg = [];
    }
    seg.push(it);
  });
  segments.push(seg);
  for (const s of segments) {
    if (s.length === 1) {
      svgEl('circle', { class: 'dot', cx: xOf(s[0]), cy: yOf(value(s[0])), r: 3 }, svg);
      continue;
    }
    const pts = s.map((it) => `${xOf(it).toFixed(1)},${yOf(value(it)).toFixed(1)}`);
    svgEl('path', { class: 'area', d: `M${xOf(s[0])},${base}L${pts.join('L')}L${xOf(s[s.length - 1])},${base}Z` }, svg);
    svgEl('path', { class: 'line', d: `M${pts.join('L')}` }, svg);
  }
  const last = items[items.length - 1];
  svgEl('circle', { class: 'dot', cx: xOf(last), cy: yOf(value(last)), r: 4 }, svg);
  const lbl = svgEl('text', { class: 'end-label', x: xOf(last) + 8, y: yOf(value(last)) + 4 }, svg);
  lbl.textContent = endLabel(last);

  const cursor = svgEl('line', { class: 'cursor', x1: 0, x2: 0, y1: top, y2: base, visibility: 'hidden' }, svg);
  const marker = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' }, svg);
  attachHover(box, items, {
    xOf,
    highlight: (k) => {
      const vis = k < 0 ? 'hidden' : 'visible';
      cursor.setAttribute('visibility', vis);
      marker.setAttribute('visibility', vis);
      if (k < 0) return;
      const x = Math.round(xOf(items[k])) + 0.5;
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
      marker.setAttribute('cx', xOf(items[k]));
      marker.setAttribute('cy', yOf(value(items[k])));
    },
    describe,
  });
}

const hourLabels = (left, right) => [
  { x: left, text: '48 h ago', anchor: 'start' },
  { x: left + (right - left) / 2, text: '24 h ago' },
  { x: right, text: 'now', anchor: 'end' },
];

// Hour rows with their column on the 48-hour grid.
function hourItems(now, rows) {
  const first = Math.floor(now / HOUR) - 47;
  return rows.map((r) => ({ ...r, i: r.h - first }));
}

function renderMissed(now) {
  const box = $('missed');
  const rows = hourRows(state.canary, now);
  if (!rows.length) {
    emptyMessage(box, state.canary ? 'No canary history yet.' : cfg.canary || cfg.demo ? 'Loading…' : 'No canary contract configured yet.');
    fillTable('missed-table', [['Hour'], ['Minutes without a tick', 1], ['Longest gap', 1]], []);
    return;
  }
  barChart(box, hourItems(now, rows), {
    slots: 48,
    value: (r) => r.missedMin,
    floor: 5,
    labels: hourLabels,
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
  const rows = hourRows(state.canary, now).filter((r) => r.blockMs !== null);
  if (rows.length < 2) {
    emptyMessage(box, state.canary ? 'Not enough canary history yet.' : cfg.canary || cfg.demo ? 'Loading…' : 'No canary contract configured yet.');
    fillTable('blocktime-table', [['Hour'], ['Seconds per block', 1], ['Blocks', 1]], []);
    return;
  }
  lineChart(box, hourItems(now, rows), {
    slots: 48,
    value: (r) => r.blockMs / 1000,
    floor: 3,
    labels: hourLabels,
    endLabel: (r) => fmtSec(r.blockMs, 2),
    describe: (r) => [`${fmtSec(r.blockMs, 2)} per block`, `${fmtClock(r.h * HOUR)} to ${fmtClock((r.h + 1) * HOUR)}`, `${fmtInt(r.blocks)} blocks`],
  });
  fillTable(
    'blocktime-table',
    [['Hour'], ['Seconds per block', 1], ['Blocks', 1]],
    [...rows].reverse().map((r) => [fmtDay(r.h * HOUR), (r.blockMs / 1000).toFixed(2), fmtInt(r.blocks)]),
  );
}

// "Last 90 days", from history.json (scripts/collect.mjs). Hidden while there
// is none, for example on a fork whose Pages workflow has not run yet.
function renderDays(now) {
  const h = state.history;
  const slots = daySlots(h, now);
  $('days').hidden = !slots.length;
  if (!slots.length) return;

  const age = now - h.updated;
  const stale = $('days-stale');
  stale.hidden = age < DAY;
  stale.textContent = `The daily history was last collected ${fmtAgo(age)}. Its GitHub Action may have stopped: GitHub pauses scheduled workflows in repositories without activity for 60 days.`;
  $('days-updated').textContent = `Collected every six hours by a GitHub Action, last ${fmtAgo(age)}. Days are UTC. The history starts on ${fmtDate(h.days[0].day)}.`;

  const labels = (left, right) => [
    { x: left, text: fmtDate(slots[0].day), anchor: 'start' },
    { x: right, text: fmtDate(slots[slots.length - 1].day), anchor: 'end' },
  ];
  const kept = [...slots].reverse().filter((s) => !s.before);

  const { svg, xOf, bw, base } = barChart($('days-missed'), slots, {
    slots: slots.length,
    value: (s) => s.row?.missedMin || 0,
    floor: 30,
    labels,
    describe: (s) => {
      if (!s.row) return [s.before ? 'Before the history started' : 'No data for this day', fmtDate(s.day)];
      const r = s.row;
      return [
        r.missedMin > 0 ? `${fmtInt(r.missedMin)} min without a tick` : 'No missed minutes',
        fmtDate(s.day),
        r.ticks ? `${s.stalls ? `${fmtInt(s.stalls)} ${s.stalls === 1 ? 'stall' : 'stalls'}, l` : 'L'}ongest gap ${fmtDur(r.maxGapMs)}` : 'No ticks this day',
      ];
    },
  });
  for (const s of slots) {
    if (!s.row && !s.before) svgEl('rect', { class: 'nodata', x: xOf(s.i), y: base - 3, width: bw, height: 3 }, svg);
  }
  fillTable(
    'days-missed-table',
    [['Day'], ['Minutes without a tick', 1], ['Stalls', 1], ['Longest gap', 1]],
    kept.map((s) =>
      s.row
        ? [fmtDate(s.day), fmtInt(s.row.missedMin), fmtInt(s.stalls), s.row.ticks ? fmtDur(s.row.maxGapMs) : '–']
        : [fmtDate(s.day), 'no data', '–', '–'],
    ),
  );

  const box = $('days-blocktime');
  const pts = slots.filter((s) => s.row?.blockMs);
  if (pts.length < 2) {
    emptyMessage(box, 'Not enough days yet.');
  } else {
    lineChart(box, pts, {
      slots: slots.length,
      value: (s) => s.row.blockMs / 1000,
      floor: 3,
      labels,
      endLabel: (s) => fmtSec(s.row.blockMs, 2),
      describe: (s) => [
        `${fmtSec(s.row.blockMs, 2)} per block`,
        fmtDate(s.day),
        `${fmtInt(s.row.blocks)} blocks`,
        ...(s.signing === null ? [] : [`${fmtInt(s.signing)} of ${fmtInt(s.total)} validators signing`]),
      ],
    });
  }
  fillTable(
    'days-blocktime-table',
    [['Day'], ['Seconds per block', 1], ['Blocks', 1], ['Validators signing', 1]],
    kept.map((s) => [
      fmtDate(s.day),
      s.row?.blockMs ? (s.row.blockMs / 1000).toFixed(2) : '–',
      s.row ? fmtInt(s.row.blocks) : '–',
      s.signing === null ? '–' : `${fmtInt(s.signing)} of ${fmtInt(s.total)}`,
    ]),
  );
}

function renderIncidents() {
  const list = $('incidents');
  list.textContent = '';
  // The canary keeps its newest 20 stalls; the daily history keeps 90 days.
  const inc = mergeIncidents(state.canary?.incidents, state.history?.incidents).reverse().slice(0, 30);
  $('incidents-note').textContent = state.history
    ? 'Gaps of three minutes or more between canary ticks. The newest 30 of the last 90 days.'
    : 'Gaps of three minutes or more between canary ticks. The canary keeps the newest 20.';
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
  const v = verdict(state, now, rpcHost);
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

  const bt = recentBlockTime(state.canary);
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

// ---------------------------------------------------------------- validators

const PAGE_SIZE = 25;
let filter = 'all';
let query = '';
let showCount = PAGE_SIZE;

function cell(tr, cls, label) {
  const td = tr.insertCell();
  if (cls) td.className = cls;
  if (label) td.dataset.label = label;
  return td;
}

function sub(text) {
  const s = document.createElement('span');
  s.className = 'op-sub';
  if (text) s.textContent = text;
  return s;
}

function heartbeatCell(td, op, hb, now, hours, tip, networkLevel) {
  if (!op) {
    td.textContent = '–';
    td.classList.add('is-empty');
    return;
  }
  if (!hb) {
    td.append(statusEl('neutral', 'Name only'), sub('No heartbeats sent'));
    return;
  }
  td.append(statusEl(hb.level, hb.label));
  const L = opLatency(op);
  const parts = [op.last ? fmtAgo(now - op.last) : 'none yet', `every ${fmtDur(op.interval * 1000)}`];
  if (L.last !== null) parts.push(`latency ${fmtSec(L.last)}`);
  td.append(sub(parts.join(', ')));
  const hint = stopHint(op, hb, tip, networkLevel);
  if (hint) {
    const h = sub(hint);
    h.classList.add('op-hint');
    td.append(h);
  }

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
    s.title = c.why
      ? `${fmtClock(c.h * HOUR)}: ${c.why}`
      : c.expected
        ? `${fmtClock(c.h * HOUR)}: ${c.beats} of ${c.expected} heartbeats`
        : `${fmtClock(c.h * HOUR)}: ${c.beats} ${c.beats === 1 ? 'heartbeat' : 'heartbeats'} so far`;
    cells.append(s);
  }
  wrap.append(pct, cells);
  td.append(wrap);
}

function renderValidators(now, networkLevel) {
  const body = $('op-body');
  const empty = $('op-empty');
  const banner = $('op-banner');
  const more = $('op-more');
  body.textContent = '';

  banner.hidden = networkLevel !== 'critical';
  banner.textContent = 'The network itself is stalled, so nobody can sign and no heartbeat can land. The statuses below reflect that, not the nodes.';

  if (!state.part && !state.ops) {
    empty.hidden = false;
    more.hidden = true;
    empty.textContent = state.errors.part ? `Couldn't load validators: ${state.errors.part.message}` : 'Loading validators…';
    return;
  }

  const narrow = window.matchMedia('(max-width: 760px)').matches;
  const hours = narrow ? 24 : 48;
  const rows = buildRows(state, now);
  document.querySelectorAll('[data-count]').forEach((n) => {
    n.textContent = fmtInt(rows.filter(FILTERS[n.dataset.count] || FILTERS.all).length);
  });

  const matches = rows.filter(FILTERS[filter] || FILTERS.all).filter((r) => matchesQuery(r, query));
  const shown = matches.slice(0, showCount);

  empty.hidden = matches.length > 0;
  if (!rows.length) empty.textContent = 'No validators found yet.';
  else if (!matches.length) empty.textContent = 'No validator matches this filter.';
  more.hidden = matches.length <= shown.length;
  more.textContent = `Show ${fmtInt(Math.min(PAGE_SIZE, matches.length - shown.length))} more of ${fmtInt(matches.length - shown.length)}`;

  const blockMs = recentBlockTime(state.canary)?.ms || 2400;
  // Signatures are read less often than heads, so measure against their own head.
  const head = Number(state.part?.head) || state.heads?.tip || 0;

  for (const r of shown) {
    const tr = body.insertRow();

    const who = cell(tr, 'c-name');
    const view = nameView(r);
    if (view) {
      const nm = document.createElement('span');
      nm.className = 'op-name';
      nm.textContent = view.name;
      const mark = document.createElement('span');
      if (view.onChain) {
        // Proves the key holder chose the name, not who they are.
        nm.title = "Set on chain with this validator's own key";
        mark.className = 'op-onchain';
        mark.innerHTML = ONCHAIN_ICON; // constant markup only
        const sr = document.createElement('span');
        sr.className = 'visually-hidden';
        sr.textContent = ", set on chain with the validator's own key";
        mark.append(sr);
      } else {
        mark.className = 'op-claim';
        mark.title = 'Typed in by whoever registered it here; not checked against the validator';
        mark.textContent = 'self-declared';
      }
      nm.append(mark);
      who.append(nm);
      if (r.address) {
        const link = explorerLink(r.address);
        link.classList.add('op-addr');
        who.append(link);
      }
      if (view.note) who.append(sub(view.note));
    } else {
      const link = explorerLink(r.address);
      link.classList.add('op-name', 'op-anon');
      who.append(link);
    }
    if (r.v) who.append(sub(`${fmtInt(Number(formatAse(r.v.stake || '0')))} ASE staked`));
    else if (r.op && !r.op.validator) who.append(sub('No validator given'));

    const sig = cell(tr, 'c-status');
    if (r.sig) sig.append(statusEl(r.sig.level, r.sig.label), sub(r.sig.sub));
    else sig.textContent = '–';

    const last = cell(tr, '', 'Last signature');
    const lsb = r.v && r.v.lastSignedBlock !== null && r.v.lastSignedBlock !== undefined ? Number(r.v.lastSignedBlock) : null;
    if (r.sig?.key === 'outside' || lsb === null || !head) {
      last.textContent = r.v && r.sig?.key !== 'outside' && lsb === null ? `None in ${fmtInt(state.part?.lookback || 1000)} blocks` : '–';
      if (last.textContent === '–') last.classList.add('is-empty');
    } else {
      const blocks = Math.max(0, head - lsb);
      last.textContent = blocks <= 1 ? 'just now' : fmtAgo(blocks * blockMs);
      last.append(sub(`block #${fmtInt(lsb)}`));
    }

    heartbeatCell(cell(tr, 'c-hb', 'Heartbeat'), r.op, r.hb, now, hours, state.heads?.tip || head, networkLevel);
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
  if (cfg.registry) add('Operator registry', explorerLink(cfg.registry));
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
  renderDays(now);
  renderValidators(now, v.level);
  renderUpdated(now);
}

// ---------------------------------------------------------------- polling

const FAST_MS = 20000;
const SLOW_MS = 2 * MIN;
// How often each source is read. Every visitor's browser reads the public RPC
// directly, so nothing is read much faster than the page can show it changing.
// Heartbeats are minutes apart. Liveness (about 50 KB) and the participation
// history (about 180 KB and seconds of work on the node) are the big responses.
// Keep the canary at a minute: verdict() warns once the last tick looks older than
// three intervals, and the time between reads adds to that age.
// history.json and names.json come from the page's own host and change every
// six hours at most.
const EVERY = { canary: MIN, ops: 2 * MIN, part: 10 * MIN, live: 2 * MIN, history: 30 * MIN, names: 30 * MIN };
const lastTry = {};
let failures = 0;
let timer = null;

function due(key, now) {
  // A failed read comes back within SLOW_MS, or a busy RPC at page load would
  // leave the validator table empty for the full ten minutes.
  const wait = state.errors[key] ? Math.min(SLOW_MS, EVERY[key]) : EVERY[key];
  if (key in lastTry && now - lastTry[key] < wait) return false;
  lastTry[key] = now;
  return true;
}

async function load(key, fn) {
  try {
    state[key] = await fn();
    state.errors[key] = null;
  } catch (e) {
    // The last good value stays; verdict() turns it into "unknown" once it is
    // older than STALE_MS, so the page never guesses from old data.
    state.errors[key] = e;
  }
}

async function poll() {
  clearTimeout(timer);
  const t = Date.now();
  const jobs = [load('heads', source.heads), load('chain', source.chainInfo)];
  if (due('canary', t)) jobs.push(load('canary', source.canary));
  if (due('ops', t)) jobs.push(load('ops', source.operators));
  if (due('part', t)) jobs.push(load('part', source.participation));
  if (due('live', t)) jobs.push(load('live', source.liveness));
  if (due('history', t)) jobs.push(load('history', source.history));
  if (due('names', t)) jobs.push(load('names', source.names));
  document.querySelectorAll('.plot').forEach((p) => p.classList.add('refreshing'));
  await Promise.allSettled(jobs);
  if (state.heads) state.finalSeen = nextFinality(state.finalSeen, state.heads.finalized, source.now());
  document.querySelectorAll('.plot').forEach((p) => p.classList.remove('refreshing'));
  if (!state.errors.heads && !state.errors.chain) state.updatedAt = source.now();
  renderAll();
  state.loadedOnce = true;
  // One failed read just waits for the next regular one. After that, wait 40 s,
  // 80 s, up to two minutes instead of adding load to a gateway that is already
  // struggling. A busy RPC drops single requests, so this still takes four failed
  // reads in a row before the last good reading ages past STALE_MS.
  failures = state.errors.heads || state.errors.chain ? failures + 1 : 0;
  if (!document.hidden) timer = setTimeout(poll, Math.min(SLOW_MS, FAST_MS * 2 ** Math.max(0, failures - 1)));
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
  showCount = PAGE_SIZE;
  document.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  renderValidators(source.now(), verdict(state, source.now(), rpcHost).level);
});

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  showCount = PAGE_SIZE;
  renderValidators(source.now(), verdict(state, source.now(), rpcHost).level);
});

$('op-more').addEventListener('click', () => {
  showCount += PAGE_SIZE;
  renderValidators(source.now(), verdict(state, source.now(), rpcHost).level);
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
