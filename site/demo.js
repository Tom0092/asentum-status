// Made-up data for ?demo, so the page can be previewed before the contracts
// are deployed. Shapes match what the contracts and the SDK return.

const MIN = 60000;
const HOUR = 3600000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const hex = (n) => '0x' + n.toString(16).padStart(40, '0');

export function createDemoSource() {
  const t0 = Date.now();
  const tip0 = 712340;
  const blockMs = 2450;
  const tipAt = (t) => tip0 + Math.floor((t - t0) / blockMs);

  // Canary: one tick a minute for 48 h, with a 14-minute stall 30 h ago and a
  // 4-minute hiccup 75 minutes ago.
  function canary(now) {
    const r = rng(7);
    const ticks = [];
    const firstTick = Math.floor((now - 48 * HOUR) / MIN) * MIN + 4100;
    for (let t = firstTick; t <= now; t += MIN) {
      const ago = now - t;
      if (ago < 30 * HOUR && ago > 30 * HOUR - 14 * MIN) continue;
      if (ago < 75 * MIN && ago > 71 * MIN) continue;
      ticks.push(t + Math.floor(r() * 1500));
    }
    // Block heights: about 24 a minute, slower between 9 and 12 hours ago.
    const inc = ticks.map((t, i) => {
      if (i === 0) return 0;
      const ago = now - t;
      const ms = ago > 9 * HOUR && ago < 12 * HOUR ? 2950 : blockMs;
      return Math.max(1, Math.round(((t - ticks[i - 1]) / ms) * (0.94 + r() * 0.12)));
    });
    const total = inc.reduce((a, b) => a + b, 0);
    let height = tipAt(ticks[ticks.length - 1]) - total;
    const withBlocks = ticks.map((t, i) => [t, (height += inc[i])]);

    const buckets = new Map();
    const incidents = [];
    let missed = 0;
    for (let i = 0; i < withBlocks.length; i++) {
      const [t, b] = withBlocks[i];
      const h = Math.floor(t / HOUR);
      const prev = withBlocks[i - 1];
      const gap = prev ? t - prev[0] : 0;
      const blocks = prev ? b - prev[1] : 0;
      if (prev) missed += Math.max(0, Math.round(gap / MIN) - 1);
      if (prev && gap >= 3 * MIN) incidents.push({ from: prev[0], to: t, gap, fromBlock: prev[1], toBlock: b });
      const k = buckets.get(h) || [h, 0, 0, 0, 0];
      k[1] += 1;
      k[2] = Math.max(k[2], gap);
      k[3] += blocks;
      k[4] += gap;
      buckets.set(h, k);
    }
    const last = withBlocks[withBlocks.length - 1];
    return {
      status: {
        version: '1',
        owner: hex(1),
        cron: hex(6),
        job: '42',
        intervalMs: MIN,
        ticks: withBlocks.length,
        missed,
        first: withBlocks[0][0],
        last: last[0],
        lastBlock: last[1],
        hourMs: HOUR,
        keepHours: 48,
      },
      recent: withBlocks.slice(-120),
      buckets: [...buckets.values()].slice(-48),
      incidents: incidents.slice(-20),
    };
  }

  const OPS = [
    { name: 'bavaria-1', n: 0xb1, interval: 300, lastAgo: 95e3, joinedAgo: 60 * HOUR, lat: 2600, gaps: [] },
    { name: 'nordlicht', n: 0xb2, interval: 300, lastAgo: 210e3, joinedAgo: 60 * HOUR, lat: 3100, gaps: [[30 * HOUR, 29.7 * HOUR]] },
    { name: 'pi4-garage', n: 0xb3, interval: 300, lastAgo: 19 * MIN, joinedAgo: 40 * HOUR, lat: 5400, gaps: [[19 * MIN, 0]] },
    { name: 'oslo-val', n: 0xb4, interval: 120, lastAgo: 50e3, joinedAgo: 70 * HOUR, lat: 2200, gaps: [] },
    { name: 'helsinki-02', n: 0xb5, interval: 300, lastAgo: 3.2 * HOUR, joinedAgo: 70 * HOUR, lat: 2900, gaps: [[3.2 * HOUR, 0]] },
    { name: 'lisbon-node', n: 0xb6, interval: 600, lastAgo: 4 * MIN, joinedAgo: 9 * HOUR, lat: 2700, gaps: [[6 * HOUR, 4 * HOUR]] },
    { name: 'tokyo-edge', n: 0xb7, interval: 300, lastAgo: null, joinedAgo: 6 * MIN, lat: -1, gaps: [] },
  ];

  function operators(now) {
    return OPS.map((o, idx) => {
      const r = rng(o.n);
      const joined = now - o.joinedAgo;
      const iv = o.interval * 1000;
      const hist = new Map();
      let beats = 0;
      if (o.lastAgo !== null) {
        for (let t = joined + iv; t <= now - o.lastAgo; t += iv) {
          const ago = now - t;
          if (o.gaps.some(([a, b]) => ago <= a && ago > b)) continue;
          const lat = Math.round(o.lat * (0.8 + r() * 0.5));
          const h = Math.floor(t / HOUR);
          const k = hist.get(h) || [h, 0, 0, 0, 0];
          k[1] += 1;
          k[2] += lat;
          k[3] = Math.max(k[3], lat);
          k[4] += 1;
          hist.set(h, k);
          beats += 1;
        }
      }
      const minHour = Math.floor(now / HOUR) - 47;
      return {
        addr: hex(0xab0000 + o.n),
        name: o.name,
        validator: idx === 6 ? '' : hex(0xfa0000 + o.n),
        interval: o.interval,
        joined,
        last: o.lastAgo === null ? 0 : now - o.lastAgo,
        lastBlock: o.lastAgo === null ? 0 : tipAt(now - o.lastAgo),
        beats,
        lat: o.lastAgo === null ? -1 : o.lat,
        ver: 'asentum-status/1.0.0',
        idx,
        hist: [...hist.values()].filter((b) => b[0] >= minHour),
      };
    });
  }

  function participation(now) {
    const r = rng(99);
    const validators = [];
    const statusFor = { 0xb5: 'dormant', 0xb3: 'idle' };
    for (let i = 0; i < 238; i++) {
      const roll = r();
      const status = roll < 0.86 ? 'signing' : roll < 0.95 ? 'idle' : 'dormant';
      validators.push({ address: hex(0xee0000 + i), stake: '0', signedBlocks: 0, participationRatio: status === 'signing' ? 0.9 + r() * 0.1 : r() * 0.3, lastSignedBlock: null, status });
    }
    for (const o of OPS.slice(0, 6)) {
      const status = statusFor[o.n] || 'signing';
      validators.push({ address: hex(0xfa0000 + o.n), stake: '0', signedBlocks: 0, participationRatio: status === 'signing' ? 0.97 : status === 'idle' ? 0.41 : 0, lastSignedBlock: null, status });
    }
    const count = (s) => validators.filter((v) => v.status === s).length;
    return { head: String(tipAt(now)), scannedFrom: '0', lookback: 1000, totalValidators: validators.length, signing: count('signing'), idle: count('idle'), dormant: count('dormant'), recentWindow: 100, validators };
  }

  const wait = (v) => new Promise((res) => setTimeout(() => res(v), 120));

  return {
    now: () => Date.now(),
    heads: () => {
      const tip = tipAt(Date.now());
      return wait({ tip, finalized: tip - 3 });
    },
    chainInfo: () => {
      const now = Date.now();
      return wait({ height: tipAt(now) - 3, timestamp: now - 3 * blockMs - 800 });
    },
    canary: () => wait(canary(Date.now())),
    operators: () => wait(operators(Date.now())),
    participation: () => wait(participation(Date.now())),
  };
}
