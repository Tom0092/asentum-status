#!/usr/bin/env node
// Write the two files the page reads next to itself:
//   history.json  the canary's 48-hour window folded into daily rows (90 days)
//   names.json    validators' primary @names from the chain, once a day
// The Pages workflow runs this every six hours and keeps both files on the
// `data` branch. Running it more often is harmless: a finished day is just
// written again, and names are only looked up when the file is 20 hours old.
//
//   node scripts/collect.mjs --out data [--names-now]
//
// Environment: ASENTUM_RPC (default: rpc in site/config.js),
// STATUS_CONFIG (site/config.js).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeClient, readSiteConfig, parseReturn, describeError } from './lib.mjs';
import { updateHistory, formatJson } from './history-lib.mjs';
import { namesDue, validatorAddresses, fetchName, lookupNames, updateNames } from './names-lib.mjs';

const { values: opt } = parseArgs({
  options: {
    out: { type: 'string', default: 'data' },
    'names-now': { type: 'boolean', default: false },
  },
});
const CONFIG = process.env.STATUS_CONFIG || fileURLToPath(new URL('../site/config.js', import.meta.url));

// A file that does not parse stops the run: starting over would throw away
// up to 90 days that the canary no longer has.
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

async function collectHistory(client, cfg, part, now) {
  if (!cfg.canary) throw new Error(`no canary address in ${CONFIG}`);
  const file = join(opt.out, 'history.json');
  const prev = readJson(file);
  const snapshot = parseReturn(await client.view(cfg.canary, 'snapshot', []));
  if (!snapshot?.status) throw new Error(`the canary at ${cfg.canary} returned no snapshot`);
  const h = updateHistory(prev, { snapshot, part, now, canary: cfg.canary });
  writeAtomic(file, formatJson(h));
  const newest = h.days[h.days.length - 1]?.day ?? 'none';
  console.log(`history.json: ${h.days.length} days (newest ${newest}), ${h.incidents.length} stalls, signing on ${h.signing.length} days`);
}

// Same paging as the page: 100 operators per view call.
async function readOperators(client, registry) {
  const items = [];
  let total = Infinity;
  while (items.length < total && items.length < 1000) {
    const page = parseReturn(await client.view(registry, 'list', [items.length, 100]));
    total = Number(page.total) || 0;
    if (!page.items?.length) break;
    items.push(...page.items);
  }
  return items;
}

async function collectNames(client, cfg, rpc, part, now) {
  const file = join(opt.out, 'names.json');
  const prev = readJson(file);
  if (!opt['names-now'] && !namesDue(prev, now, cfg.rpc)) {
    console.log(`names.json: checked ${Math.round((now - prev.updated) / 3600000)} h ago, next check after 20 h`);
    return;
  }
  if (!part) throw new Error('no participation list, so no validators to look up');
  const ops = cfg.registry ? await readOperators(client, cfg.registry) : [];
  const addresses = validatorAddresses(part, ops);
  const t0 = Date.now();
  const { found, failed } = await lookupNames(addresses, (a) => fetchName(rpc, a));
  const n = updateNames(prev, { found, failed, checked: addresses.length, now, rpc: cfg.rpc });
  writeAtomic(file, formatJson(n));
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`names.json: ${Object.keys(n.names).length} names among ${addresses.length} validators, ${failed.length} lookups failed, ${secs} s`);
}

async function main() {
  const cfg = await readSiteConfig(CONFIG);
  const rpc = process.env.ASENTUM_RPC || cfg.rpc;
  const client = makeClient(rpc);
  mkdirSync(opt.out, { recursive: true });
  const now = Date.now();

  let part = null;
  try {
    part = await client.getParticipation({ lookback: 1000 });
  } catch (e) {
    console.warn(`Participation not read: ${describeError(e)}`);
  }

  // One failing does not stop the other.
  let failed = 0;
  for (const [what, run] of [
    ['history', () => collectHistory(client, cfg, part, now)],
    ['names', () => collectNames(client, cfg, rpc, part, now)],
  ]) {
    try {
      await run();
    } catch (e) {
      failed += 1;
      console.error(`collect ${what}: ${describeError(e)}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`collect: ${describeError(e)}`);
  process.exit(1);
});
