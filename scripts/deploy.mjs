#!/usr/bin/env node
// Deploy the heartbeat registry and the canary, schedule the canary on the
// chain's cron registry (ARC-21) and write the addresses into site/config.js.
//
// Safe to re-run: progress is kept in deploy-state.json and finished steps
// are skipped, so a timeout halfway through costs nothing.
//
//   node scripts/deploy.mjs [--escrow 1] [--repo https://github.com/<you>/asentum-status]
//
// Environment: ASENTUM_RPC (default https://testnet.asentum.com),
// DEPLOY_KEY (keys/deployer.json), DEPLOY_STATE (deploy-state.json),
// STATUS_CONFIG (site/config.js).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aseToWei, formatAse } from '@asentum/sdk';
import { CRON_REGISTRY, makeClient, loadWallet, readSiteConfig, writeSiteConfig, parseReturn, describeError } from './lib.mjs';

const root = new URL('..', import.meta.url);
const here = (rel) => fileURLToPath(new URL(rel, root));

const { values: opt } = parseArgs({
  options: {
    escrow: { type: 'string', default: '1' },
    repo: { type: 'string' },
    interval: { type: 'string', default: '60000' },
    'job-gas': { type: 'string', default: '1000000' },
  },
});

const RPC = process.env.ASENTUM_RPC || 'https://testnet.asentum.com';
const KEY = process.env.DEPLOY_KEY || here('keys/deployer.json');
const STATE = process.env.DEPLOY_STATE || here('deploy-state.json');
const CONFIG = process.env.STATUS_CONFIG || here('site/config.js');
const INTERVAL = Number(opt.interval);
const JOB_GAS = Number(opt['job-gas']);
const ESCROW = aseToWei(opt.escrow);

const client = makeClient(RPC);
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
const log = (...a) => console.log(...a);

async function waitOk(hash, what, until = 'included') {
  const r = await client.waitForReceipt(hash, { until, timeoutMs: until === 'final' ? 180000 : 90000 });
  if (!r.success) throw new Error(`${what} failed in block ${r.blockNumber}: ${r.error || 'no reason given'}`);
  return r;
}

async function view(addr, method, args = []) {
  return parseReturn(await client.view(addr, method, args));
}

async function deployContract(wallet, key, file) {
  if (state[key]) {
    const src = await client.getContractSource(state[key]);
    if (src) return state[key];
    if (state[`${key}Tx`]) {
      log(`Waiting for the earlier deploy of ${file} (${state[`${key}Tx`]})…`);
      await waitOk(state[`${key}Tx`], `deploy of ${file}`, 'final');
      return state[key];
    }
  }
  const source = readFileSync(here(file), 'utf8');
  log(`Deploying ${file} (${source.length} bytes)…`);
  const c = await wallet.deploy(source);
  state[key] = c.address;
  state[`${key}Tx`] = c.deployTx.hash;
  save();
  await waitOk(c.deployTx.hash, `deploy of ${file}`, 'final');
  log(`  ${file} is at ${c.address}`);
  return c.address;
}

async function initOnce(wallet, addr, statusMethod, args, label) {
  const s = await view(addr, statusMethod);
  if (s && s.owner) {
    if (s.owner !== wallet.addressHex) log(`  note: ${label} is owned by ${s.owner}, not by this key`);
    return;
  }
  log(`Initializing ${label}…`);
  const tx = await wallet.sendCall({ to: addr, method: 'init', args });
  await waitOk(tx.hash, `init of ${label}`);
}

async function main() {
  const wallet = loadWallet(client, KEY);
  log(`RPC      ${RPC}`);
  log(`Deployer ${wallet.address}`);

  const chainId = await client.getChainId();
  log(`Chain id ${chainId}`);
  const bal = BigInt((await client.getBalance(wallet.address)).balance);
  log(`Balance  ${formatAse(bal)} ASE`);
  const need = state.job ? 0n : ESCROW;
  if (bal <= need) {
    throw new Error(`the deployer needs more than ${formatAse(need)} ASE (canary escrow plus fees). Send test ASE to ${wallet.address} and run again.`);
  }

  const probe = await client.viewCall(CRON_REGISTRY, 'getJob', ['0']);
  if (!probe.ok && !/not found|unknown job|no such job|null/i.test(probe.reason || '')) {
    log(`  warning: the cron registry at ${CRON_REGISTRY} answered: ${probe.reason}. Scheduling may fail.`);
  }

  // 1. Heartbeat registry
  const registry = await deployContract(wallet, 'registry', 'contracts/heartbeat-registry.js');
  await initOnce(wallet, registry, 'info', [], 'the heartbeat registry');

  // 2. Canary
  const canary = await deployContract(wallet, 'canary', 'contracts/canary.js');
  await initOnce(wallet, canary, 'status', [CRON_REGISTRY, INTERVAL], 'the canary');

  // 3. Schedule the canary on the cron registry (the wallet owns the job).
  if (!state.job) {
    if (!state.scheduleTx) {
      const info = await client.getChainInfo();
      const chainNow = Number(info.latestHeader?.timestamp) || Date.now();
      const firstRun = chainNow + 2 * 60000;
      log(`Scheduling canary.tick every ${INTERVAL / 1000} s, escrow ${formatAse(ESCROW)} ASE…`);
      const tx = await wallet.sendCall({
        to: CRON_REGISTRY,
        method: 'schedule',
        args: [canary, 'tick', [], String(firstRun), String(INTERVAL), '0', String(JOB_GAS)],
        valueWei: ESCROW,
      });
      state.scheduleTx = tx.hash;
      save();
    }
    const r = await client.waitForReceipt(state.scheduleTx, { timeoutMs: 90000 });
    if (!r.success) {
      const why = r.error || 'no reason given';
      delete state.scheduleTx;
      save();
      throw new Error(`scheduling failed: ${why}`);
    }
    const ev = (r.events || []).find((e) => e.name === 'JobScheduled');
    const data = ev && typeof ev.data === 'object' ? ev.data : {};
    const id = data.jobId ?? data.id ?? data.job ?? parseReturn(r.returnValue);
    if (id === undefined || id === null || typeof id === 'object') {
      throw new Error(`the schedule transaction ${state.scheduleTx} succeeded, but no job id was found in its receipt. Look it up on the explorer, then add "job": "<id>" to ${STATE} and run again.`);
    }
    state.job = String(id);
    save();
    log(`  cron job ${state.job}`);
  }

  // 4. Record the job id on the canary (shown on the page).
  const st = await view(canary, 'status');
  if (st.job !== state.job) {
    log('Recording the job id on the canary…');
    const tx = await wallet.sendCall({ to: canary, method: 'setJob', args: [state.job] });
    await waitOk(tx.hash, 'setJob');
  }

  // 5. Page config
  const existing = await readSiteConfig(CONFIG);
  const cfg = {
    rpc: RPC,
    explorer: existing.explorer || 'https://explorer.asentum.com',
    registry,
    canary,
    cronJob: state.job,
    repo: opt.repo ?? existing.repo ?? '',
  };
  writeSiteConfig(CONFIG, cfg);

  // 6. Check
  const info = await view(registry, 'info');
  const cs = await view(canary, 'status');
  log('');
  log('Done.');
  log(`  Heartbeat registry  ${registry}  (${info.operators} operators)`);
  log(`  Canary              ${canary}  (cron job ${cs.job}, ${cs.ticks} ticks so far)`);
  log(`  Page config         ${CONFIG}`);
  log('');
  log('Next: commit site/config.js and push. GitHub Pages publishes the page.');
  log('The first canary tick lands about two minutes from now.');
}

main().catch((e) => {
  console.error(`\nDeploy stopped: ${describeError(e)}`);
  console.error(`Progress is saved in ${STATE}; run the same command again to continue.`);
  process.exit(1);
});
