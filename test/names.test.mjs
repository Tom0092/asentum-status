// Primary @names from the chain (scripts/names-lib.mjs) and how the page shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAse1 } from '@asentum/sdk';
import { namesDue, validatorAddresses, nameFrom, fetchName, lookupNames, updateNames, NAMES_EVERY_MS } from '../scripts/names-lib.mjs';
import { buildRows, nameView, matchesQuery, FILTERS } from '../site/logic.js';

const hexAddr = (n) => '0x' + n.toString(16).padStart(40, '0');
const A = toAse1(hexAddr(0xa));
const B = toAse1(hexAddr(0xb));
const C = toAse1(hexAddr(0xc));
const RPC = 'https://rpc.example';

function reply(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

test('nameFrom takes a name only for the address asked for', () => {
  assert.equal(nameFrom({ ase1: A, name: 'alpha' }, A), 'alpha');
  assert.equal(nameFrom({ ase1: A, name: ' alpha ' }, A), 'alpha');
  assert.equal(nameFrom({ ase1: A, name: null }, A), null);
  assert.equal(nameFrom({ ase1: B, name: 'beta' }, A), null);
  assert.equal(nameFrom({ ase1: null, name: null, error: 'invalid address' }, A), null);
  assert.equal(nameFrom({ ase1: A, name: 'two words' }, A), null);
  assert.equal(nameFrom({ ase1: A, name: 'x'.repeat(65) }, A), null);
});

test('fetchName retries 429 and 5xx, fails at once on 404', async () => {
  const seen = [];
  const answers = [reply(429, null, { 'retry-after': '0' }), reply(503, null), reply(200, { ase1: A, name: 'alpha' })];
  const fetchFn = async (url) => {
    seen.push(url);
    return answers.shift();
  };
  assert.equal(await fetchName(RPC, A, { fetchFn, pauseMs: 1 }), 'alpha');
  assert.equal(seen.length, 3);
  assert.equal(seen[0], `${RPC}/name-of/${A}`);

  let calls = 0;
  const notFound = async () => {
    calls += 1;
    return reply(404, null);
  };
  await assert.rejects(fetchName(RPC, A, { fetchFn: notFound, pauseMs: 1 }), /HTTP 404/);
  assert.equal(calls, 1);

  const down = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(fetchName(RPC, A, { fetchFn: down, pauseMs: 1, tries: 2 }), /ECONNRESET/);
});

test('lookupNames keeps going past failures', async () => {
  const addrs = Array.from({ length: 9 }, (_, i) => toAse1(hexAddr(0x100 + i)));
  let running = 0;
  let most = 0;
  const lookup = async (a) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((res) => setTimeout(res, 5));
    running -= 1;
    if (a === addrs[3]) throw new Error('boom');
    return a === addrs[5] ? 'five' : null;
  };
  const { found, failed } = await lookupNames(addrs, lookup, 4);
  assert.deepEqual(found, { [addrs[5]]: 'five' });
  assert.deepEqual(failed, [addrs[3]]);
  assert.equal(most, 4);
});

test('updateNames keeps old names for failed lookups, refuses a bad run', () => {
  const prev = { version: 1, updated: 1, rpc: RPC, checked: 3, names: { [A]: 'old-a', [B]: 'old-b' } };
  const n = updateNames(prev, { found: { [C]: 'gamma' }, failed: [A], checked: 3, now: 5, rpc: RPC });
  assert.deepEqual(n.names, { [A]: 'old-a', [C]: 'gamma' }, 'B lost its name, A could not be checked');
  assert.deepEqual(Object.keys(n.names), [...Object.keys(n.names)].sort());
  assert.equal(n.updated, 5);

  const other = updateNames(prev, { found: {}, failed: [A], checked: 3, now: 5, rpc: 'https://other.example' });
  assert.deepEqual(other.names, {}, 'names of another network are not carried over');

  const many = Array.from({ length: 11 }, (_, i) => toAse1(hexAddr(0x200 + i)));
  assert.throws(() => updateNames(prev, { found: {}, failed: many, checked: 100, now: 5, rpc: RPC }), /11 of 100/);
});

test('namesDue once the file is 20 hours old or for another network', () => {
  const prev = { version: 1, updated: 1000, rpc: RPC, names: {} };
  assert.equal(namesDue(null, 5000, RPC), true);
  assert.equal(namesDue(prev, 1000 + NAMES_EVERY_MS - 1, RPC), false);
  assert.equal(namesDue(prev, 1000 + NAMES_EVERY_MS, RPC), true);
  assert.equal(namesDue(prev, 2000, 'https://other.example'), true);
});

test('validatorAddresses: participation plus registry, once each', () => {
  const part = { validators: [{ address: A }, { address: B }] };
  const ops = [{ validator: hexAddr(0xb) }, { validator: hexAddr(0xc) }, { validator: '' }];
  assert.deepEqual(validatorAddresses(part, ops), [A, B, C].sort());
});

// ------------------------------------------------------------------ page

const NOW = 1794400000000;

function rows(names) {
  const val = (address) => ({ address, status: 'signing', stake: '1000', participationRatio: 0.99, lastSignedBlock: '10' });
  return buildRows(
    {
      ops: [
        { addr: hexAddr(0x101), name: 'pacemaker', validator: hexAddr(0xa), interval: 0, last: 0 },
        { addr: hexAddr(0x102), name: 'same', validator: hexAddr(0xb), interval: 0, last: 0 },
      ],
      part: { lookback: 1000, recentWindow: 100, validators: [val(A), val(B), val(C), val(toAse1(hexAddr(0xd)))] },
      live: { maxConsecutiveMisses: 50, tracked: [] },
      names,
      errors: {},
    },
    NOW,
  );
}

test('nameView: chain name first, the registry name as a self-declared note', () => {
  const r = rows({ [A]: 'heartbeat-labs', [B]: 'Same', [C]: 'gamma' });
  const by = (a) => r.find((x) => x.address === a);
  assert.deepEqual(nameView(by(A)), { name: '@heartbeat-labs', onChain: true, note: 'Listed here as pacemaker (self-declared)' });
  assert.deepEqual(nameView(by(B)), { name: '@Same', onChain: true, note: null }, 'same name, any case: no note');
  assert.deepEqual(nameView(by(C)), { name: '@gamma', onChain: true, note: null });
  const plain = rows(null);
  assert.deepEqual(nameView(plain.find((x) => x.address === A)), { name: 'pacemaker', onChain: false, note: null });
  assert.equal(nameView(plain.find((x) => x.address === C)), null);
});

test('search, the Named filter and sorting count chain names', () => {
  const r = rows({ [C]: 'gamma' });
  assert.equal(r.filter(FILTERS.named).length, 3);
  assert.deepEqual(r.slice(0, 3).map((x) => x.chainName || x.op?.name), ['gamma', 'pacemaker', 'same']);
  const hits = (q) => r.filter((x) => matchesQuery(x, q)).map((x) => x.address);
  assert.deepEqual(hits('@GAM'), [C]);
  assert.deepEqual(hits('pace'), [A]);
  assert.deepEqual(hits(C.slice(-6)), [C]);
  assert.equal(hits('  ').length, 4);
});
