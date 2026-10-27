// Asentum Status: Operator Registry (v1)
//
// Validator operators register once to put a public name on their validator.
// Validators in the committee are tracked from their block signatures, so a
// name is all they need (interval 0). Operators outside the committee, or who
// want to check that their node's transaction path works, can also send a
// small "beat" transaction every few minutes. The registry then keeps the last
// beat, inclusion latency (block time minus the time the sender signed the
// beat) and 48 hourly buckets for uptime charts.
//
// Anyone can register; a validator address can carry one name. The page at
// asentum-status reads everything through free view calls. Names are public:
// the owner can remove abusive entries.
//
// Runtime notes (Asentum JavaScript contracts):
//   - storage holds strings only, so records are JSON.
//   - msg.sender is lowercase 0x hex; chain.* values are BigInt.
//   - the last expression of this file is the contract object.

const HOUR_MS = 3600000;
const KEEP_HOURS = 48;
const MIN_GAP_MS = 30000;          // two beats from one operator at least 30 s apart
const MIN_INTERVAL_S = 60;
const MAX_INTERVAL_S = 3600;
const MAX_OPERATORS = 500;
const MAX_PAGE = 100;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const HEX_ADDR_RE = /^0x[0-9a-f]{40}$/;

function readJson(key, fallback) {
  const raw = storage.get(key);
  return raw === undefined ? fallback : JSON.parse(raw);
}

function writeJson(key, value) {
  storage.set(key, JSON.stringify(value));
}

function count() {
  return Number(storage.get('n') || '0');
}

function readOp(addr) {
  return readJson('o:' + String(addr).toLowerCase(), null);
}

function requireOwner() {
  assert(msg.sender === storage.get('owner'), 'only the owner');
}

function cleanName(name) {
  const n = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  assert(NAME_RE.test(n), 'name: 3-24 chars, a-z 0-9 _ -, starting with a letter or digit');
  return n;
}

// 0 means "name only, no heartbeats".
function cleanInterval(intervalSec) {
  const i = Number(intervalSec);
  assert(Number.isInteger(i), 'interval must be a whole number of seconds');
  assert(i === 0 || (i >= MIN_INTERVAL_S && i <= MAX_INTERVAL_S), 'interval must be 0 (no heartbeats) or 60 to 3600 seconds');
  return i;
}

function requireSomething(interval, validator) {
  assert(interval > 0 || validator, 'without heartbeats (interval 0) a registration needs a validator address');
}

// One name per validator: v:<validator> points at the registration that names it.
function linkValidator(rec, validator) {
  if (rec.validator === validator) return;
  if (validator) {
    const holder = storage.get('v:' + validator);
    assert(!holder || holder === rec.addr, 'this validator already has a name');
  }
  if (rec.validator) storage.delete('v:' + rec.validator);
  if (validator) storage.set('v:' + validator, rec.addr);
  rec.validator = validator;
}

function cleanValidator(validator) {
  if (validator === undefined || validator === null || validator === '') return '';
  const v = String(validator).toLowerCase();
  assert(HEX_ADDR_RE.test(v), 'validator must be an address (ase1 is converted by the SDK)');
  return v;
}

function cleanVersion(version) {
  const v = String(version === undefined || version === null ? '' : version);
  return v.replace(/[^\x20-\x7e]/g, '').slice(0, 32);
}

// Hourly buckets: [hourIndex, beats, latencySumMs, latencyMaxMs, latencySamples]
function bump(buckets, hour, lat) {
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  const has = lat >= 0;
  if (last && last[0] === hour) {
    last[1] += 1;
    if (has) {
      last[2] += lat;
      last[3] = Math.max(last[3], lat);
      last[4] += 1;
    }
  } else {
    buckets.push([hour, 1, has ? lat : 0, has ? lat : 0, has ? 1 : 0]);
  }
  const oldest = hour - KEEP_HOURS + 1;
  while (buckets.length && buckets[0][0] < oldest) buckets.shift();
  return buckets;
}

function withHistory(rec) {
  const out = Object.assign({}, rec);
  out.hist = readJson('h:' + rec.addr, []);
  return out;
}

function removeOp(addr) {
  const rec = readOp(addr);
  assert(rec, 'not registered');
  const n = count();
  const lastIdx = n - 1;
  if (rec.idx !== lastIdx) {
    const movedAddr = storage.get('i:' + lastIdx);
    const moved = readOp(movedAddr);
    moved.idx = rec.idx;
    writeJson('o:' + movedAddr, moved);
    storage.set('i:' + rec.idx, movedAddr);
  }
  storage.delete('i:' + lastIdx);
  storage.delete('o:' + rec.addr);
  storage.delete('nm:' + rec.name);
  storage.delete('h:' + rec.addr);
  if (rec.validator) storage.delete('v:' + rec.validator);
  storage.set('n', String(n - 1));
  emit('Unregistered', { op: rec.addr, name: rec.name });
}

({
  // Call once, right after deploy. The caller becomes the owner (moderation only).
  init() {
    assert(!storage.has('owner'), 'already initialized');
    storage.set('owner', msg.sender);
    storage.set('n', '0');
  },

  // name: public label.
  // intervalSec: 0 for a name only, or how often you will beat (60-3600).
  // validator: the validator you operate (required when intervalSec is 0).
  register(name, intervalSec, validator) {
    assert(storage.has('owner'), 'not initialized');
    const me = msg.sender;
    const n = cleanName(name);
    const interval = cleanInterval(intervalSec);
    const val = cleanValidator(validator);
    requireSomething(interval, val);
    assert(!storage.has('o:' + me), 'this address is already registered');
    assert(!storage.has('nm:' + n), 'name is taken');
    const idx = count();
    assert(idx < MAX_OPERATORS, 'registry is full');

    const rec = {
      addr: me,
      name: n,
      validator: '',
      interval,
      joined: Number(chain.blockTimestamp),
      last: 0,
      lastBlock: 0,
      beats: 0,
      lat: -1,
      ver: '',
      idx,
    };
    linkValidator(rec, val);
    writeJson('o:' + me, rec);
    storage.set('nm:' + n, me);
    storage.set('i:' + idx, me);
    storage.set('n', String(idx + 1));
    emit('Registered', { op: me, name: n });
    return rec;
  },

  // Change interval and validator. To change the name, unregister and register again.
  update(intervalSec, validator) {
    const rec = readOp(msg.sender);
    assert(rec, 'not registered');
    const interval = cleanInterval(intervalSec);
    const val = cleanValidator(validator);
    requireSomething(interval, val);
    rec.interval = interval;
    linkValidator(rec, val);
    writeJson('o:' + rec.addr, rec);
    return rec;
  },

  // sentAt: the sender's wall clock in ms when it signed this beat.
  // version: free text such as the sender version (max 32 printable chars).
  beat(sentAt, version) {
    const rec = readOp(msg.sender);
    assert(rec, 'not registered');
    assert(rec.interval > 0, 'heartbeats are off for this registration (interval 0); set an interval with update first');
    const now = Number(chain.blockTimestamp);
    assert(rec.last === 0 || now - rec.last >= MIN_GAP_MS, 'heartbeat too frequent');

    let lat = -1;
    const s = Number(sentAt);
    if (Number.isFinite(s) && s > 0) {
      const d = now - s;
      // Ignore clocks that are badly off (more than 60 s ahead or 1 h behind).
      if (d >= -60000 && d <= HOUR_MS) lat = Math.max(0, Math.round(d));
    }

    rec.last = now;
    rec.lastBlock = Number(chain.blockNumber);
    rec.beats += 1;
    rec.lat = lat;
    rec.ver = cleanVersion(version);
    writeJson('o:' + rec.addr, rec);

    const hour = Math.floor(now / HOUR_MS);
    writeJson('h:' + rec.addr, bump(readJson('h:' + rec.addr, []), hour, lat));

    emit('Beat', { op: rec.addr, lat });
    return { block: rec.lastBlock, lat };
  },

  unregister() {
    removeOp(msg.sender);
  },

  // --- owner (moderation) ---

  removeOperator(addr) {
    requireOwner();
    removeOp(String(addr).toLowerCase());
  },

  transferOwnership(newOwner) {
    requireOwner();
    const o = String(newOwner).toLowerCase();
    assert(HEX_ADDR_RE.test(o), 'invalid address');
    storage.set('owner', o);
  },

  // --- views (free) ---

  info() {
    return {
      version: '1',
      owner: storage.get('owner') || '',
      operators: count(),
      hourMs: HOUR_MS,
      keepHours: KEEP_HOURS,
      minGapMs: MIN_GAP_MS,
      maxOperators: MAX_OPERATORS,
    };
  },

  getOperator(addr) {
    const rec = readOp(addr);
    return rec ? withHistory(rec) : null;
  },

  getByName(name) {
    const addr = storage.get('nm:' + String(name).trim().toLowerCase());
    return addr ? withHistory(readOp(addr)) : null;
  },

  getByValidator(validator) {
    const addr = storage.get('v:' + String(validator).toLowerCase());
    return addr ? withHistory(readOp(addr)) : null;
  },

  // Operators by index, with history. limit 1-100.
  list(offset, limit) {
    const n = count();
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const lim = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || MAX_PAGE)));
    const out = [];
    for (let i = from; i < Math.min(n, from + lim); i++) {
      out.push(withHistory(readOp(storage.get('i:' + i))));
    }
    return { total: n, offset: from, items: out };
  },
})
