// Validators' primary @names from the chain's own name service
// (GET <rpc>/name-of/<address>). Such a name is set with the address's own
// key, so unlike a name in the operator registry it shows who chose it. The
// page cannot ask for a thousand names on every visit, so scripts/collect.mjs
// asks once a day and writes names.json. Tested in test/names.test.mjs.
import { toAse1 } from '@asentum/sdk';

export const NAMES_EVERY_MS = 20 * 3600000;
const NAME_RE = /^[^\s\p{C}]{1,64}$/u;

export function namesDue(prev, now, rpc) {
  return !prev || prev.version !== 1 || prev.rpc !== rpc || !(now - prev.updated < NAMES_EVERY_MS);
}

// Every validator in the participation list, plus every validator named in the
// registry (a registered one can be missing from the list).
export function validatorAddresses(part, ops) {
  const set = new Set();
  for (const v of part?.validators || []) set.add(toAse1(v.address));
  for (const o of ops || []) if (o.validator) set.add(toAse1(o.validator));
  return [...set].sort();
}

// The name in one /name-of answer, or null. The answer must be about the
// address asked for: the node answers 200 even for an invalid address.
export function nameFrom(answer, address) {
  if (!answer || answer.ase1 !== address || typeof answer.name !== 'string') return null;
  const name = answer.name.trim();
  return NAME_RE.test(name) ? name : null;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// One lookup. 429, 5xx and network errors are tried again with a growing
// pause (or the server's Retry-After); any other status fails at once.
export async function fetchName(rpc, address, { fetchFn = fetch, tries = 4, pauseMs = 2000, timeoutMs = 15000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res = null;
    let err = null;
    try {
      res = await fetchFn(`${rpc}/name-of/${address}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      err = e;
    }
    if (res?.ok) return nameFrom(await res.json(), address);
    if (res && res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    if (attempt >= tries) throw err || new Error(`HTTP ${res.status}`);
    const after = Number(res?.headers?.get('retry-after'));
    await sleep(after > 0 ? Math.min(after, 60) * 1000 : pauseMs * 2 ** (attempt - 1));
  }
}

// Look every address up, `parallel` at a time. A failed lookup is listed in
// `failed`, it does not stop the others.
export async function lookupNames(addresses, lookup, parallel = 4) {
  const found = {};
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) {
      const address = addresses[next++];
      try {
        const name = await lookup(address);
        if (name) found[address] = name;
      } catch {
        failed.push(address);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, addresses.length) }, worker));
  return { found, failed };
}

// The new names.json, with names only (most validators have none). An
// address whose lookup failed keeps its old name. When many lookups fail the
// node is struggling: keep the old file instead of thinning it out.
export function updateNames(prev, { found, failed, checked, now, rpc }) {
  if (failed.length > Math.max(10, checked * 0.1)) {
    throw new Error(`${failed.length} of ${checked} name lookups failed, the old names stay`);
  }
  const old = prev?.version === 1 && prev.rpc === rpc ? prev.names || {} : {};
  const names = { ...found };
  for (const a of failed) if (old[a]) names[a] = old[a];
  return {
    version: 1,
    updated: now,
    rpc,
    checked,
    names: Object.fromEntries(Object.entries(names).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
