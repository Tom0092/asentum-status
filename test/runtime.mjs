// A small in-memory stand-in for the Asentum contract VM, for unit tests.
//
// It follows the documented runtime: contracts run in a Hardened JavaScript
// (SES) compartment; injected globals are storage, msg, chain, emit, assert,
// E, transfer and harden; storage holds strings; msg.sender is lowercase 0x
// hex; chain values are BigInt; a call that throws rolls back every write.
// Arguments and return values pass through JSON like they do over the SDK.
// Storage gas is counted with the documented prices (execution gas is not).
import 'ses';

lockdown({ errorTaming: 'unsafe', consoleTaming: 'unsafe', overrideTaming: 'severe' });

const GAS = { read: 800, newKey: 20000, update: 2900, del: 5000, keysBase: 800, keysPer: 800 };

const toJson = (v) =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function hexAddr(n) {
  return '0x' + n.toString(16).padStart(40, '0');
}

export class MockChain {
  constructor({ startMs = Date.UTC(2026, 9, 27, 12, 0, 0), block = 100000 } = {}) {
    this.time = BigInt(startMs);
    this.block = BigInt(block);
    this.chainId = 1423n;
  }

  // Move time forward; blocks default to one every 2 s.
  advance(ms, blocks) {
    this.time += BigInt(ms);
    this.block += BigInt(blocks ?? Math.max(1, Math.round(ms / 2000)));
  }

  deploy(source, address = hexAddr(0xc0ffee)) {
    return new MockContract(this, source, address);
  }
}

class MockContract {
  constructor(chain, source, address) {
    this.chain = chain;
    this.address = address;
    this.source = source;
    this.data = new Map();
    this.events = [];
    this.gas = 0;
    const self = this;

    const storage = harden({
      get(k) {
        self.gas += GAS.read;
        return self.data.get(String(k));
      },
      has(k) {
        self.gas += GAS.read;
        return self.data.has(String(k));
      },
      set(k, v) {
        const key = String(k);
        self.gas += self.data.has(key) ? GAS.update : GAS.newKey;
        self.data.set(key, String(v));
      },
      delete(k) {
        self.gas += GAS.del;
        return self.data.delete(String(k));
      },
      keys(prefix = '') {
        const out = [...self.data.keys()].filter((k) => k.startsWith(prefix)).sort();
        self.gas += GAS.keysBase + GAS.keysPer * out.length;
        return out;
      },
    });

    this.compartment = new Compartment({
      globals: {
        storage,
        msg: undefined,
        chain: undefined,
        emit: harden((name, data) => {
          self.pending.push({ name: String(name), data: toJson(data) });
        }),
        assert: harden((cond, message = 'assertion failed') => {
          if (!cond) throw new Error(message);
        }),
        E: harden(() => {
          throw new Error('E(): not available in the test runtime');
        }),
        transfer: harden(() => {
          throw new Error('transfer(): not available in the test runtime');
        }),
      },
      __options__: true,
    });
    this.api = this.compartment.evaluate(source);
    if (!this.api || typeof this.api !== 'object') throw new Error('contract source must end in an object literal');
  }

  setContext(sender, value = 0n) {
    const g = this.compartment.globalThis;
    g.msg = harden({ sender: sender.toLowerCase(), value: BigInt(value), contractAddress: this.address });
    g.chain = harden({ blockNumber: this.chain.block, blockTimestamp: this.chain.time, chainId: this.chain.chainId });
  }

  // A transaction: throws on failure and rolls back storage.
  send(sender, method, args = [], { value = 0n } = {}) {
    const fn = this.api[method];
    if (typeof fn !== 'function') throw new Error(`no method ${method}`);
    const snapshot = new Map(this.data);
    this.pending = [];
    this.gas = 0;
    this.setContext(sender, value);
    try {
      const ret = fn.apply(undefined, toJson(args));
      this.events.push(...this.pending);
      return toJson(ret);
    } catch (e) {
      this.data = snapshot;
      throw new Error(`contract method '${method}' failed: ${e.message}`);
    }
  }

  // A free read: never keeps changes.
  view(method, args = [], sender = hexAddr(0)) {
    const snapshot = new Map(this.data);
    const eventCount = this.events.length;
    try {
      return this.send(sender, method, args);
    } finally {
      this.data = snapshot;
      this.events.length = eventCount;
    }
  }
}
