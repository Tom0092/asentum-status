// A minimal stand-in for an Asentum node's REST API, for end-to-end tests of
// scripts/deploy.mjs and sender/heartbeat.mjs. It decodes the real signed
// transactions the SDK produces (SSZ, ML-DSA-65 key in the tx), derives the
// sender like the chain does (BLAKE3 of the public key), runs the contracts
// in the SES test runtime, and serves receipts and views.
import http from 'node:http';
import { ByteListType, ByteVectorType, ContainerType, UintBigintType } from '@chainsafe/ssz';
import { blake3 } from '@noble/hashes/blake3';
import { toHexAddress, toAse1 } from '@asentum/sdk';
import { MockChain, hexAddr } from './runtime.mjs';

const Uint64 = new UintBigintType(8);
const Uint256 = new UintBigintType(32);
const Address = new ByteVectorType(20);
const Body = new ContainerType({
  chainId: Uint64,
  nonce: Uint64,
  maxPriorityFeePerGas: Uint256,
  maxFeePerGas: Uint256,
  gasLimit: Uint64,
  to: Address,
  value: Uint256,
  data: new ByteListType(1048576),
});
const Signed = new ContainerType({ body: Body, publicKey: new ByteVectorType(1952), signature: new ByteVectorType(3309) });

const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const ZERO = hexAddr(0);
export const CRON = hexAddr(6);

// The cron registry (ARC-21) as the docs describe it.
class CronRegistry {
  constructor(node) {
    this.node = node;
    this.jobs = new Map();
    this.nextId = 1;
    this.current = null;
  }
  send(sender, method, args, { value = 0n } = {}) {
    const t = this.node.chain.time;
    if (method === 'schedule') {
      const [target, m, a, nextRunAt, intervalMs, maxRuns, gasLimit] = args;
      if (BigInt(nextRunAt) <= t) throw new Error("contract method 'schedule' failed: nextRunAt must be in the future");
      if (BigInt(value) < BigInt(gasLimit)) throw new Error("contract method 'schedule' failed: escrow too small");
      const id = String(this.nextId++);
      this.jobs.set(id, { id, owner: sender, target: String(target).toLowerCase(), method: m, args: a, nextRunAt: BigInt(nextRunAt), interval: BigInt(intervalMs), maxRuns: Number(maxRuns), runs: 0, escrow: BigInt(value) });
      this.events = [{ name: 'JobScheduled', data: { jobId: id, owner: sender, target: String(target).toLowerCase() } }];
      return id;
    }
    if (method === 'cancel') {
      const job = this.jobs.get(String(args[0]));
      if (!job || job.owner !== sender) throw new Error("contract method 'cancel' failed: not the owner");
      this.jobs.delete(job.id);
      return true;
    }
    throw new Error(`no method ${method}`);
  }
  view(method, args) {
    if (method === 'getJob') {
      const j = this.jobs.get(String(args[0]));
      return j ? { id: j.id, owner: j.owner, target: j.target, method: j.method, nextRunAt: String(j.nextRunAt), intervalSec: String(j.interval), escrow: String(j.escrow) } : null;
    }
    throw new Error(`no method ${method}`);
  }
  runDue() {
    for (const job of [...this.jobs.values()]) {
      if (job.nextRunAt > this.node.chain.time) continue;
      const target = this.node.contracts.get(job.target);
      try {
        target.send(CRON, job.method, job.args);
      } catch {
        /* a failed run is billed and stays scheduled */
      }
      job.runs += 1;
      job.escrow -= 50000n;
      while (job.nextRunAt <= this.node.chain.time) job.nextRunAt += job.interval;
      if (job.interval === 0n || (job.maxRuns && job.runs >= job.maxRuns)) this.jobs.delete(job.id);
    }
  }
}

export async function startMockNode({ startMs = Date.now() } = {}) {
  const node = {
    chain: new MockChain({ startMs, block: 500000 }),
    contracts: new Map(),
    balances: new Map(),
    nonces: new Map(),
    receipts: new Map(),
    dropTx: false, // when true, /tx accepts but never mines (a stuck node)
    txLog: [],
    validators: new Map(), // hex address -> participation status

  };
  node.contracts.set(CRON, new CronRegistry(node));
  node.fund = (addr, wei) => {
    const h = toHexAddress(addr);
    node.balances.set(h, (node.balances.get(h) || 0n) + BigInt(wei));
  };
  // Advance chain time, letting the cron registry run due jobs every block.
  node.advance = (ms) => {
    const step = 2000;
    for (let t = 0; t < ms; t += step) {
      node.chain.advance(Math.min(step, ms - t), 1);
      node.contracts.get(CRON).runDue();
    }
  };

  function execute(rawHex) {
    const tx = Signed.deserialize(Buffer.from(rawHex.replace(/^0x/, ''), 'hex'));
    const sender = hex(blake3(tx.publicKey).slice(0, 20));
    const b = tx.body;
    const hash = hex(blake3(Buffer.from(rawHex.replace(/^0x/, ''), 'hex')));
    const nonce = node.nonces.get(sender) || 0n;
    if (b.chainId !== 1423n) return { accepted: false, reason: 'wrong chain id' };
    if (b.nonce !== nonce) return { accepted: false, reason: `stale nonce: account is at ${nonce}, tx has ${b.nonce}` };
    const bal = node.balances.get(sender) || 0n;
    if (bal < b.value) return { accepted: false, reason: 'insufficient balance' };
    node.nonces.set(sender, nonce + 1n);
    if (node.dropTx) return { accepted: true, txHash: hash };

    node.chain.advance(2000, 1);
    const to = hex(b.to);
    const receipt = {
      txHash: hash,
      blockNumber: String(node.chain.block),
      txIndex: 0,
      sender,
      recipient: to,
      kind: 'call',
      success: true,
      gasUsed: '50000',
      events: [],
      finalized: true,
      confirmations: '3',
      blockHash: hex(blake3(Buffer.from(String(node.chain.block)))),
    };
    try {
      const data = Buffer.from(b.data).toString('utf8');
      if (to === ZERO) {
        const buf = new Uint8Array(28);
        buf.set(Buffer.from(sender.slice(2), 'hex'), 0);
        new DataView(buf.buffer).setBigUint64(20, nonce, false);
        const addr = hex(blake3(buf).slice(0, 20));
        node.contracts.set(addr, node.chain.deploy(data, addr));
        receipt.kind = 'deploy';
        receipt.recipient = addr;
      } else {
        const target = node.contracts.get(to);
        if (!target) throw new Error('no contract at address');
        const { method, args } = JSON.parse(data);
        node.txLog.push({ sender, to, method, args });
        const before = target.events?.length ?? 0;
        receipt.returnValue = target.send(sender, method, args, { value: b.value });
        receipt.events = target === node.contracts.get(CRON) ? target.events : target.events.slice(before);
      }
      node.balances.set(sender, bal - b.value);
      if (to !== ZERO && b.value) node.balances.set(to, (node.balances.get(to) || 0n) + b.value);
    } catch (e) {
      receipt.success = false;
      receipt.error = e.message;
    }
    node.receipts.set(hash, receipt);
    node.contracts.get(CRON).runDue();
    return { accepted: true, txHash: hash };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
    const send = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST' });
      return res.end();
    }
    const p = url.pathname;
    if (p === '/participation') {
      const vals = [...node.validators.entries()].map(([address, status]) => ({
        address,
        stake: String(2000n * 10n ** 18n),
        signedBlocks: status === 'dormant' ? 0 : 900,
        participationRatio: status === 'signing' ? 0.98 : status === 'idle' ? 0.2 : 0,
        lastSignedBlock: status === 'dormant' ? null : String(node.chain.block - (status === 'idle' ? 400n : 1n)),
        status,
      }));
      const count = (s) => vals.filter((v) => v.status === s).length;
      return send({ head: String(node.chain.block), scannedFrom: '0', lookback: 1000, totalValidators: vals.length, signing: count('signing'), idle: count('idle'), dormant: count('dormant'), recentWindow: 100, validators: vals });
    }
    if (p === '/consensus/liveness') {
      const tracked = [...node.validators.entries()]
        .filter(([, status]) => status !== 'dormant')
        .map(([address, status]) => ({ address, lastVotedHeight: String(node.chain.block - (status === 'idle' ? 400n : 1n)), consecutiveMisses: status === 'idle' ? 60 : 0, baked: false }));
      return send({ head: String(node.chain.block), livenessWindow: '100', maxConsecutiveMisses: 50, baked: [], tracked });
    }
    const header = () => ({ number: String(node.chain.block), timestamp: String(node.chain.time), proposer: toAse1(hexAddr(9)) });
    try {
      if (p === '/chain') return send({ chainId: '1423', height: Number(node.chain.block), mempoolSize: 0, latestHeader: header() });
      if (p === '/v3/heads') return send({ finalized: Number(node.chain.block), tip: Number(node.chain.block) + 2 });
      if (p.startsWith('/balance/')) {
        const a = toHexAddress(decodeURIComponent(p.slice(9)));
        const n = String(node.nonces.get(a) || 0n);
        return send({ address: a, balance: String(node.balances.get(a) || 0n), nonce: n, pendingNonce: n });
      }
      if (p.startsWith('/public-key/')) return send({ address: decodeURIComponent(p.slice(12)), recorded: false, keyHash: null, keylessActive: false, keylessFromBlock: null, nextBlock: String(node.chain.block + 1n), canOmitKey: false });
      if (p === '/tx' && req.method === 'POST') return send(execute(JSON.parse(body).rawTx));
      if (p.startsWith('/receipts/')) {
        const r = node.receipts.get(decodeURIComponent(p.slice(10)));
        return send(r || { error: 'receipt not found' });
      }
      if (p === '/view' && req.method === 'POST') {
        const { contract, method, args } = JSON.parse(body);
        const c = node.contracts.get(toHexAddress(contract));
        if (!c) return send({ ok: false, reason: 'no contract at address' });
        try {
          return send({ ok: true, returnValue: c.view(method, args), blockNumber: String(node.chain.block), finalized: true });
        } catch (e) {
          return send({ ok: false, reason: e.message });
        }
      }
      if (p === '/' && req.method === 'POST') {
        const { id, method, params } = JSON.parse(body);
        if (method === 'eth_getCode') {
          const c = node.contracts.get(toHexAddress(params[0]));
          const src = c?.source ? '0x' + Buffer.from(c.source).toString('hex') : c && c !== node.contracts.get(CRON) ? '0x01' : '0x';
          return send({ jsonrpc: '2.0', id, result: src });
        }
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
      }
      return send({ error: 'not found' }, 404);
    } catch (e) {
      return send({ error: e.message }, 500);
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  node.url = `http://127.0.0.1:${server.address().port}`;
  node.close = () => new Promise((r) => server.close(r));
  return node;
}
