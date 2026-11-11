#!/usr/bin/env node
// Fold the canary's 48-hour window into the daily history (history.json) that
// the page's "Last 90 days" section reads. The Pages workflow runs this every
// six hours and keeps the file on the `data` branch. Running it more often is
// harmless: a finished day is just written again.
//
//   node scripts/collect.mjs --out data
//
// Environment: ASENTUM_RPC (default: rpc in site/config.js),
// STATUS_CONFIG (site/config.js).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeClient, readSiteConfig, parseReturn, describeError } from './lib.mjs';
import { updateHistory, formatJson } from './history-lib.mjs';

const { values: opt } = parseArgs({ options: { out: { type: 'string', default: 'data' } } });
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

async function main() {
  const cfg = await readSiteConfig(CONFIG);
  if (!cfg.canary) throw new Error(`no canary address in ${CONFIG}`);
  const client = makeClient(process.env.ASENTUM_RPC || cfg.rpc);
  mkdirSync(opt.out, { recursive: true });
  const file = join(opt.out, 'history.json');
  const prev = readJson(file);

  const snapshot = parseReturn(await client.view(cfg.canary, 'snapshot', []));
  if (!snapshot?.status) throw new Error(`the canary at ${cfg.canary} returned no snapshot`);
  let part = null;
  try {
    part = await client.getParticipation({ lookback: 1000 });
  } catch (e) {
    console.warn(`Participation not read, no signing sample this time: ${describeError(e)}`);
  }

  const h = updateHistory(prev, { snapshot, part, now: Date.now(), canary: cfg.canary });
  writeAtomic(file, formatJson(h));
  const newest = h.days[h.days.length - 1]?.day ?? 'none';
  console.log(`history.json: ${h.days.length} days (newest ${newest}), ${h.incidents.length} stalls, signing on ${h.signing.length} days`);
}

main().catch((e) => {
  console.error(`collect: ${describeError(e)}`);
  process.exit(1);
});
