// Asentum Status: Testnet Canary (v1)
//
// The chain's own cron registry (ARC-21) calls tick() once a minute. Each
// tick records the block time and height. A gap much longer than the interval
// means the chain (or its cron) stalled: that becomes an incident. Hourly
// buckets feed the coverage and block-time charts on the status page.
//
// No off-chain keeper. If ticks stop, the chain stopped running jobs.
//
// Anyone can schedule another job that targets tick(); such extra runs within
// half an interval of the last tick are ignored, so they cannot inflate the
// numbers, and they cannot hide a stall (during a stall no job runs at all).

const HOUR_MS = 3600000;
const KEEP_HOURS = 48;
const KEEP_TICKS = 120;            // last 2 hours of ticks at one per minute
const MAX_INCIDENTS = 20;
const HEX_ADDR_RE = /^0x[0-9a-f]{40}$/;

function readJson(key, fallback) {
  const raw = storage.get(key);
  return raw === undefined ? fallback : JSON.parse(raw);
}

function writeJson(key, value) {
  storage.set(key, JSON.stringify(value));
}

function num(key) {
  return Number(storage.get(key) || '0');
}

function requireOwner() {
  assert(msg.sender === storage.get('owner'), 'only the owner');
}

function statusOf() {
  return {
    version: '1',
    owner: storage.get('owner') || '',
    cron: storage.get('cron') || '',
    job: storage.get('job') || '',
    intervalMs: num('interval'),
    ticks: num('ticks'),
    missed: num('missed'),
    first: num('first'),
    last: num('last'),
    lastBlock: num('lastBlock'),
    hourMs: HOUR_MS,
    keepHours: KEEP_HOURS,
  };
}

// Hourly buckets: [hourIndex, ticks, maxGapMs, blocksElapsed, msElapsed]
function bump(buckets, hour, gap, blocks) {
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  if (last && last[0] === hour) {
    last[1] += 1;
    last[2] = Math.max(last[2], gap);
    last[3] += blocks;
    last[4] += gap;
  } else {
    buckets.push([hour, 1, gap, blocks, gap]);
  }
  const oldest = hour - KEEP_HOURS + 1;
  while (buckets.length && buckets[0][0] < oldest) buckets.shift();
  return buckets;
}

({
  // cron: the cron registry address (ase1 from the SDK, arrives as hex).
  // intervalMs: the job interval you schedule, at least 60000.
  init(cron, intervalMs) {
    assert(!storage.has('owner'), 'already initialized');
    const c = String(cron).toLowerCase();
    assert(HEX_ADDR_RE.test(c), 'cron must be an address');
    const i = Number(intervalMs);
    assert(Number.isInteger(i) && i >= 60000, 'intervalMs must be at least 60000');
    storage.set('owner', msg.sender);
    storage.set('cron', c);
    storage.set('interval', String(i));
    storage.set('ticks', '0');
    storage.set('missed', '0');
  },

  // Record the cron job id (shown on the page, used to read the escrow).
  setJob(jobId) {
    requireOwner();
    storage.set('job', String(jobId));
  },

  transferOwnership(newOwner) {
    requireOwner();
    const o = String(newOwner).toLowerCase();
    assert(HEX_ADDR_RE.test(o), 'invalid address');
    storage.set('owner', o);
  },

  // Called by the cron registry. Safe to run again (no external effects).
  tick() {
    assert(msg.sender === storage.get('cron'), 'only the cron registry');
    const now = Number(chain.blockTimestamp);
    const blk = Number(chain.blockNumber);
    const interval = num('interval');
    const last = num('last');
    const lastBlock = num('lastBlock');

    if (last && now - last < interval / 2) return 'ignored: too early';

    let gap = 0;
    let blocks = 0;
    let missed = 0;
    if (last) {
      gap = now - last;
      blocks = blk - lastBlock;
      missed = Math.max(0, Math.round(gap / interval) - 1);
    }

    const ticks = num('ticks') + 1;
    storage.set('ticks', String(ticks));
    storage.set('last', String(now));
    storage.set('lastBlock', String(blk));
    if (!storage.has('first')) storage.set('first', String(now));
    if (missed) storage.set('missed', String(num('missed') + missed));

    const hour = Math.floor(now / HOUR_MS);
    writeJson('b', bump(readJson('b', []), hour, gap, blocks));

    const recent = readJson('r', []);
    recent.push([now, blk]);
    while (recent.length > KEEP_TICKS) recent.shift();
    writeJson('r', recent);

    if (last && gap >= 3 * interval) {
      const inc = readJson('inc', []);
      inc.push({ from: last, to: now, gap, fromBlock: lastBlock, toBlock: blk });
      while (inc.length > MAX_INCIDENTS) inc.shift();
      writeJson('inc', inc);
      emit('Stall', { from: last, to: now, gap });
    }
    return 'ok';
  },

  // --- views (free) ---

  status() {
    return statusOf();
  },

  buckets() {
    return readJson('b', []);
  },

  incidents() {
    return readJson('inc', []);
  },

  // The last ticks as [timeMs, blockNumber], oldest first.
  recent() {
    return readJson('r', []);
  },

  // Everything the status page needs in one call.
  snapshot() {
    return {
      status: statusOf(),
      recent: readJson('r', []),
      buckets: readJson('b', []),
      incidents: readJson('inc', []),
    };
  },
})
