#!/usr/bin/env node
// Asentum Status operator tool: name your validator, optionally send heartbeats.
//
//   node sender/heartbeat.mjs keygen [--force]
//   node sender/heartbeat.mjs address
//   node sender/heartbeat.mjs register <name> --validator ase1... --no-heartbeat   (name only)
//   node sender/heartbeat.mjs register <name> [--interval 300] [--validator ase1...]
//   node sender/heartbeat.mjs update [--interval 300 | --no-heartbeat] [--validator ase1...|none]
//   node sender/heartbeat.mjs beat          (what the systemd timer runs)
//   node sender/heartbeat.mjs status
//   node sender/heartbeat.mjs unregister
//
// Environment:
//   HB_KEYFILE     heartbeat wallet (default keys/heartbeat.json)
//   HB_RPC         node or gateway to send through (default https://testnet.asentum.com).
//                  Point it at your own node to test that your node relays transactions.
//   HB_REGISTRY    registry address (default: the one in site/config.js)
//   HB_TIMEOUT_MS  how long a beat may take to land before it counts as stuck (default 90000)
//   HB_ALERT_URL   optional: POSTed on failure and on recovery (ntfy topic URL or any webhook)
//   HB_STATE_DIR   where the last result is kept for recovery alerts (default: next to the key)
//
// Exit codes for beat: 0 ok, 2 stuck (not in a block in time), 3 rejected by the node,
// 4 network error, 5 failed in a block, 1 anything else.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AsentumContract, formatAse, TimeoutError, TxRejectedError, NetworkError, isAse1 } from '@asentum/sdk';
import { makeClient, createKeyFile, loadWallet, readSiteConfig, parseReturn, describeError } from '../scripts/lib.mjs';

const VERSION = 'asentum-status/1.0.0';
const root = new URL('..', import.meta.url);
const here = (rel) => fileURLToPath(new URL(rel, root));

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    interval: { type: 'string' },
    validator: { type: 'string' },
    'no-heartbeat': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
const [cmd, ...rest] = positionals;

const RPC = process.env.HB_RPC || 'https://testnet.asentum.com';
const KEYFILE = process.env.HB_KEYFILE || here('keys/heartbeat.json');
const TIMEOUT = Number(process.env.HB_TIMEOUT_MS) || 90000;
const ALERT_URL = process.env.HB_ALERT_URL || '';
const STATE_DIR = process.env.HB_STATE_DIR || dirname(KEYFILE);

const client = makeClient(RPC);

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function registryAddress() {
  if (process.env.HB_REGISTRY) return process.env.HB_REGISTRY.trim();
  const cfg = await readSiteConfig(here('site/config.js'));
  if (!cfg.registry) throw new Exit(1, 'no registry address: set HB_REGISTRY or deploy first (site/config.js)');
  return cfg.registry;
}

// 0 = name only (no heartbeats).
function intervalArg(fallback) {
  if (opt['no-heartbeat']) {
    if (opt.interval !== undefined) throw new Exit(1, 'use either --interval or --no-heartbeat');
    return 0;
  }
  const v = opt.interval === undefined ? fallback : Number(opt.interval);
  if (!Number.isInteger(v) || (v !== 0 && (v < 60 || v > 3600))) throw new Exit(1, '--interval must be 60 to 3600 seconds (or use --no-heartbeat)');
  return v;
}

function validatorArg(fallback) {
  const v = opt.validator === undefined ? fallback : opt.validator.trim();
  if (!v || v === 'none') return '';
  if (!isAse1(v) && !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Exit(1, '--validator must be an ase1 address (or "none")');
  return v;
}

async function send(registry, wallet, method, args) {
  const c = new AsentumContract(client, registry).connect(wallet);
  const tx = await c.send(method, args);
  const r = await tx.wait({ timeoutMs: TIMEOUT });
  if (!r.success) throw new Exit(5, `${method} failed in block ${r.blockNumber}: ${r.error || 'no reason given'}`);
  return { tx, r };
}

// ------------------------------------------------------------------ alerts

const statePath = () => join(STATE_DIR, 'heartbeat-state.json');

function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n');
  } catch (e) {
    console.error(`could not write ${statePath()}: ${e.message}`);
  }
}

async function alert(title, message, priority) {
  if (!ALERT_URL) return;
  try {
    const ntfy = /ntfy/i.test(ALERT_URL);
    const res = await fetch(ALERT_URL, {
      method: 'POST',
      headers: ntfy
        ? { Title: title, Priority: priority === 'high' ? '4' : '3', Tags: priority === 'high' ? 'warning' : 'white_check_mark' }
        : { 'Content-Type': 'application/json' },
      body: ntfy ? message : JSON.stringify({ title, message, priority, source: VERSION }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`alert POST answered ${res.status}`);
  } catch (e) {
    console.error(`alert POST failed: ${e.message}`);
  }
}

// ------------------------------------------------------------------ commands

const commands = {
  async keygen() {
    const w = createKeyFile(client, KEYFILE, { force: opt.force });
    console.log(`Created ${KEYFILE}`);
    console.log(`Address: ${w.address}`);
    console.log('Send this address a little test ASE (0.1 is plenty), then run: register <name>');
  },

  async address() {
    const w = loadWallet(client, KEYFILE);
    const b = await client.getBalance(w.address);
    console.log(`${w.address}  ${formatAse(b.balance)} ASE`);
  },

  async register() {
    const name = rest[0];
    if (!name) throw new Exit(1, 'usage: register <name> --validator ase1... [--no-heartbeat | --interval 300]');
    const interval = intervalArg(300);
    const validator = validatorArg('');
    if (!interval && !validator) throw new Exit(1, '--no-heartbeat needs --validator: a name has to point at something');
    const registry = await registryAddress();
    const w = loadWallet(client, KEYFILE);
    const { r } = await send(registry, w, 'register', [name, interval, validator]);
    const rec = parseReturn(r.returnValue) || {};
    console.log(`Registered "${rec.name || name}" from ${w.address} in block ${r.blockNumber}.`);
    if (interval) console.log('Now send heartbeats: run "beat" once to test, then enable the systemd timer.');
    else console.log('Done. The name shows on the status page next to your validator.');
  },

  async update() {
    const registry = await registryAddress();
    const w = loadWallet(client, KEYFILE);
    const cur = parseReturn(await client.view(registry, 'getOperator', [w.address]));
    if (!cur) throw new Exit(1, `${w.address} is not registered`);
    const interval = intervalArg(cur.interval);
    const validator = validatorArg(cur.validator);
    if (!interval && !validator) throw new Exit(1, 'without heartbeats the registration needs a validator');
    await send(registry, w, 'update', [interval, validator]);
    console.log(`Updated: ${interval ? `heartbeat every ${interval} s` : 'name only'}${validator ? `, validator ${validator}` : ''}.`);
  },

  async beat() {
    const registry = await registryAddress();
    const w = loadWallet(client, KEYFILE);
    const prev = readState();
    const sentAt = Date.now();
    const result = { at: new Date(sentAt).toISOString(), rpc: RPC };
    try {
      const c = new AsentumContract(client, registry).connect(w);
      let tx;
      try {
        tx = await c.send('beat', [String(sentAt), VERSION]);
      } catch (e) {
        if (e instanceof TxRejectedError) throw new Exit(3, `rejected by the node: ${e.reason}`);
        if (e instanceof NetworkError) throw new Exit(4, `could not reach ${RPC}: ${describeError(e)}`);
        throw e;
      }
      result.hash = tx.hash;
      let r;
      try {
        r = await tx.wait({ timeoutMs: TIMEOUT });
      } catch (e) {
        if (e instanceof TimeoutError) throw new Exit(2, `not in a block after ${Math.round(TIMEOUT / 1000)} s (tx ${tx.hash})`);
        if (e instanceof NetworkError) throw new Exit(4, `lost ${RPC} while waiting: ${describeError(e)}`);
        throw e;
      }
      if (!r.success) throw new Exit(5, `failed in block ${r.blockNumber}: ${r.error || 'no reason given'}`);
      result.ok = true;
      result.block = Number(r.blockNumber);
      result.includedMs = Date.now() - sentAt;
      console.log(JSON.stringify({ level: 'info', msg: 'heartbeat landed', ...result }));
      writeState(result);
      if (prev.ok === false) {
        await alert('Heartbeat recovered', `Heartbeats from ${w.address} land again (block ${result.block}, ${result.includedMs} ms). Last failure: ${prev.error}`, 'default');
      }
    } catch (e) {
      const code = e instanceof Exit ? e.code : 1;
      result.ok = false;
      result.code = code;
      result.error = describeError(e);
      console.error(JSON.stringify({ level: 'error', msg: 'heartbeat failed', ...result }));
      writeState(result);
      if (prev.ok !== false) {
        await alert('Heartbeat failed', `Heartbeat from ${w.address} via ${RPC}: ${result.error}`, 'high');
      }
      throw new Exit(code, result.error);
    }
  },

  async status() {
    const registry = await registryAddress();
    const w = loadWallet(client, KEYFILE);
    const op = parseReturn(await client.view(registry, 'getOperator', [w.address]));
    if (!op) {
      console.log(`${w.address} is not registered.`);
      return;
    }
    const age = op.last ? `${Math.round((Date.now() - op.last) / 1000)} s ago` : 'never';
    console.log(`name       ${op.name}`);
    console.log(`address    ${w.address}`);
    console.log(`heartbeat  ${op.interval ? `every ${op.interval} s` : 'off (name only)'}`);
    console.log(`validator  ${op.validator || '-'}`);
    console.log(`beats      ${op.beats}`);
    console.log(`last beat  ${age} (block ${op.lastBlock})`);
    console.log(`latency    ${op.lat >= 0 ? `${op.lat} ms` : '-'}`);
  },

  async unregister() {
    const registry = await registryAddress();
    const w = loadWallet(client, KEYFILE);
    await send(registry, w, 'unregister', []);
    console.log('Unregistered.');
  },
};

const run = commands[cmd];
if (!run) {
  console.error('usage: heartbeat.mjs keygen|address|register|update|beat|status|unregister');
  process.exit(1);
}
run().catch((e) => {
  if (!(e instanceof Exit && cmd === 'beat')) console.error(describeError(e));
  process.exit(e instanceof Exit ? e.code : 1);
});
