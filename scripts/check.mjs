#!/usr/bin/env node
// Quick look at a deployment: chain, canary, cron job, registry.
//   npm run check
// Reads site/config.js (STATUS_CONFIG overrides the path); ASENTUM_RPC overrides the RPC.
import { fileURLToPath } from 'node:url';
import { formatAse } from '@asentum/sdk';
import { CRON_REGISTRY, makeClient, readSiteConfig, parseReturn, describeError } from './lib.mjs';

const cfg = await readSiteConfig(process.env.STATUS_CONFIG || fileURLToPath(new URL('../site/config.js', import.meta.url)));
const rpc = process.env.ASENTUM_RPC || cfg.rpc || 'https://testnet.asentum.com';
const client = makeClient(rpc);
const ago = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`);
let problems = 0;
const bad = (msg) => {
  problems += 1;
  console.log(`  !! ${msg}`);
};

console.log(`RPC        ${rpc}`);
try {
  const heads = await client.getHeads();
  const info = await client.getChainInfo();
  const finalAge = Date.now() - Number(info.latestHeader?.timestamp || 0);
  console.log(`Chain      tip ${heads.tip}, final ${heads.finalized} (${ago(finalAge)})`);
  if (finalAge > 120000) bad('no new final block for over two minutes');
} catch (e) {
  bad(`chain not reachable: ${describeError(e)}`);
}

if (!cfg.canary) {
  console.log('Canary     not deployed yet (site/config.js has no canary address)');
} else {
  try {
    const s = parseReturn(await client.view(cfg.canary, 'status', []));
    const last = s.last ? ago(Date.now() - s.last) : 'never';
    console.log(`Canary     ${cfg.canary}`);
    console.log(`           ${s.ticks} ticks, last ${last}, ${s.missed} missed minutes, job ${s.job || '-'}`);
    if (!s.ticks) console.log('           (the first tick lands about two minutes after deploy)');
    else if (Date.now() - s.last > 3 * s.intervalMs) bad('the canary has not ticked for over three intervals');
    if (s.job) {
      const job = parseReturn(await client.view(CRON_REGISTRY, 'getJob', [s.job]).catch(() => null));
      if (!job) bad(`cron job ${s.job} not found: it ended (escrow used up?) or was cancelled`);
      else if (job.escrow !== undefined) console.log(`           escrow left ${formatAse(job.escrow)} ASE`);
    }
  } catch (e) {
    bad(`canary not readable: ${describeError(e)}`);
  }
}

if (!cfg.registry) {
  console.log('Registry   not deployed yet');
} else {
  try {
    const r = parseReturn(await client.view(cfg.registry, 'info', []));
    console.log(`Registry   ${cfg.registry}`);
    console.log(`           ${r.operators} registered, owner ${r.owner}`);
  } catch (e) {
    bad(`registry not readable: ${describeError(e)}`);
  }
}

console.log(problems ? `\n${problems} problem(s).` : '\nAll good.');
process.exit(problems ? 1 : 0);
