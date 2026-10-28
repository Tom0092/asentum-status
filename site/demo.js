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

  // val: the validator's state in signatures; interval 0 = name only.
  const OPS = [
    { name: 'bavaria-1', n: 0xb1, val: 'signing', interval: 300, lastAgo: 95e3, joinedAgo: 60 * HOUR, lat: 2600, gaps: [] },
    { name: 'nordlicht', n: 0xb2, val: 'signing', interval: 0 },
    { name: 'frankfurt-pq', n: 0xb8, val: 'missing', interval: 0 },
    { name: 'pi4-garage', n: 0xb3, val: 'dormant', interval: 300, lastAgo: 19 * MIN, joinedAgo: 40 * HOUR, lat: 5400, gaps: [[19 * MIN, 0]] },
    { name: 'oslo-val', n: 0xb4, val: 'signing', interval: 120, lastAgo: 50e3, joinedAgo: 70 * HOUR, lat: 2200, gaps: [] },
    { name: 'helsinki-02', n: 0xb5, val: 'idle', interval: 300, lastAgo: 3.2 * HOUR, joinedAgo: 70 * HOUR, lat: 2900, gaps: [[3.2 * HOUR, 0]] },
    { name: 'lisbon-node', n: 0xb6, val: 'dormant', interval: 600, lastAgo: 4 * MIN, joinedAgo: 9 * HOUR, lat: 2700, gaps: [[6 * HOUR, 4 * HOUR]] },
    { name: 'tokyo-edge', n: 0xb7, val: null, interval: 300, lastAgo: null, joinedAgo: 6 * MIN, lat: -1, gaps: [] },
  ];

  function operators(now) {
    return OPS.map((o, idx) => {
      const r = rng(o.n);
      const joined = now - (o.joinedAgo || 20 * HOUR);
      const hist = new Map();
      let beats = 0;
      if (o.interval && o.lastAgo !== null) {
        const iv = o.interval * 1000;
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
      const beating = o.interval && o.lastAgo !== null;
      const minHour = Math.floor(now / HOUR) - 47;
      return {
        addr: hex(0xab0000 + o.n),
        name: o.name,
        validator: o.val ? hex(0xfa0000 + o.n) : '',
        interval: o.interval,
        joined,
        last: beating ? now - o.lastAgo : 0,
        lastBlock: beating ? tipAt(now - o.lastAgo) : 0,
        beats,
        lat: beating ? o.lat : -1,
        ver: beating ? 'asentum-status/1.0.0' : '',
        idx,
        hist: [...hist.values()].filter((b) => b[0] >= minHour),
      };
    });
  }

  // About 240 bonded validators: the top 100 by stake sit in the committee.
  function validatorSet(now) {
    const r = rng(99);
    const head = tipAt(now);
    const ase = (n) => (BigInt(Math.round(n)) * 10n ** 18n).toString();
    const list = [];
    const entry = (address, kind, stake) => {
      const seated = kind !== 'dormant';
      const last = kind === 'signing' || kind === 'missing' ? head - Math.floor(r() * 3) : kind === 'idle' ? head - 300 - Math.floor(r() * 500) : null;
      list.push({
        v: {
          address,
          stake: ase(stake),
          signedBlocks: seated ? Math.round(1000 * (kind === 'idle' ? 0.4 : 0.97)) : 0,
          participationRatio: kind === 'signing' ? 0.95 + r() * 0.05 : kind === 'missing' ? 0.88 : kind === 'idle' ? 0.41 : 0,
          lastSignedBlock: last === null ? null : String(last),
          status: kind === 'missing' ? 'signing' : kind,
        },
        misses: kind === 'missing' ? 4 : kind === 'idle' ? 0 : 0,
        seated,
      });
    };
    for (let i = 0; i < 232; i++) {
      const seated = i < 94;
      const roll = r();
      const kind = !seated ? 'dormant' : roll < 0.93 ? 'signing' : roll < 0.97 ? 'idle' : 'missing';
      entry(hex(0xee0000 + i), kind, seated ? 1400 + (94 - i) * 180 + r() * 90 : 500 + r() * 840);
    }
    for (const o of OPS) {
      if (!o.val) continue;
      const stake = o.val === 'dormant' ? 620 + r() * 300 : 2400 + r() * 6000;
      entry(hex(0xfa0000 + o.n), o.val, stake);
    }
    return { head, list };
  }

  function participation(now) {
    const { head, list } = validatorSet(now);
    const validators = list.map((x) => x.v);
    const count = (s) => validators.filter((v) => v.status === s).length;
    return { head: String(head), scannedFrom: String(head - 1000), lookback: 1000, totalValidators: validators.length, signing: count('signing'), idle: count('idle'), dormant: count('dormant'), recentWindow: 100, validators };
  }

  function liveness(now) {
    const { head, list } = validatorSet(now);
    return {
      head: String(head),
      livenessWindow: '100',
      maxConsecutiveMisses: 50,
      baked: [],
      tracked: list.filter((x) => x.seated).map((x) => ({ address: x.v.address, lastVotedHeight: x.v.lastSignedBlock, consecutiveMisses: x.misses, baked: false })),
    };
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
    canaryStatus: () => wait(canary(Date.now()).status),
    operators: () => wait(operators(Date.now())),
    participation: () => wait(participation(Date.now())),
    liveness: () => wait(liveness(Date.now())),
  };
}
