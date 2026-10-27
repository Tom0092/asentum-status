import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockChain, hexAddr } from './runtime.mjs';

const SOURCE = readFileSync(new URL('../contracts/heartbeat-registry.js', import.meta.url), 'utf8');
const OWNER = hexAddr(1);
const ALICE = hexAddr(0xa11ce);
const BOB = hexAddr(0xb0b);
const CAROL = hexAddr(0xca201);
const VAL = hexAddr(0x7a1);
const HOUR = 3600000;

function setup() {
  const chain = new MockChain();
  const hb = chain.deploy(SOURCE);
  hb.send(OWNER, 'init');
  return { chain, hb };
}

test('source stays under the 64 KB contract limit', () => {
  assert.ok(Buffer.byteLength(SOURCE) < 64 * 1024);
});

test('init runs once and sets the owner', () => {
  const { hb } = setup();
  assert.throws(() => hb.send(ALICE, 'init'), /already initialized/);
  const info = hb.view('info');
  assert.equal(info.owner, OWNER);
  assert.equal(info.operators, 0);
});

test('register validates name, interval and validator', () => {
  const { hb } = setup();
  assert.throws(() => hb.send(ALICE, 'register', ['ab', 300, '']), /name/);
  assert.throws(() => hb.send(ALICE, 'register', ['-tom', 300, '']), /name/);
  assert.throws(() => hb.send(ALICE, 'register', ['tom smith', 300, '']), /name/);
  assert.throws(() => hb.send(ALICE, 'register', ['x'.repeat(25), 300, '']), /name/);
  assert.throws(() => hb.send(ALICE, 'register', ['tom', 30, '']), /interval/);
  assert.throws(() => hb.send(ALICE, 'register', ['tom', 7200, '']), /interval/);
  assert.throws(() => hb.send(ALICE, 'register', ['tom', 90.5, '']), /interval/);
  assert.throws(() => hb.send(ALICE, 'register', ['tom', 300, 'ase1notconverted']), /validator/);

  const rec = hb.send(ALICE, 'register', ['  Tom-Node_1 ', 300, VAL.toUpperCase().replace('0X', '0x')]);
  assert.equal(rec.name, 'tom-node_1');
  assert.equal(rec.validator, VAL);
  assert.equal(rec.idx, 0);
  assert.deepEqual(hb.events.at(-1), { name: 'Registered', data: { op: ALICE, name: 'tom-node_1' } });
});

test('one registration per address, names are unique', () => {
  const { hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  assert.throws(() => hb.send(ALICE, 'register', ['beta', 300, '']), /already registered/);
  assert.throws(() => hb.send(BOB, 'register', ['ALPHA', 300, '']), /taken/);
  hb.send(BOB, 'register', ['beta', 120, null]);
  assert.equal(hb.view('info').operators, 2);
  assert.equal(hb.view('getByName', ['Beta']).addr, BOB);
});

test('beat records last seen, latency and hourly buckets', () => {
  const { chain, hb } = setup();
  assert.throws(() => hb.send(ALICE, 'beat', [Date.now(), 'v1']), /not registered/);
  hb.send(ALICE, 'register', ['alpha', 300, '']);

  const sentAt = Number(chain.time) - 2500;
  const r = hb.send(ALICE, 'beat', [String(sentAt), 'hb/1.0.0']);
  assert.equal(r.lat, 2500);

  const op = hb.view('getOperator', [ALICE]);
  assert.equal(op.beats, 1);
  assert.equal(op.last, Number(chain.time));
  assert.equal(op.lastBlock, Number(chain.block));
  assert.equal(op.lat, 2500);
  assert.equal(op.ver, 'hb/1.0.0');
  assert.deepEqual(op.hist, [[Math.floor(Number(chain.time) / HOUR), 1, 2500, 2500, 1]]);
  assert.deepEqual(hb.events.at(-1), { name: 'Beat', data: { op: ALICE, lat: 2500 } });
});

test('beats closer than 30 s are rejected and roll back', () => {
  const { chain, hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 60, '']);
  hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v']);
  chain.advance(10000);
  assert.throws(() => hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v']), /too frequent/);
  assert.equal(hb.view('getOperator', [ALICE]).beats, 1);
  chain.advance(20000);
  hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v']);
  assert.equal(hb.view('getOperator', [ALICE]).beats, 2);
});

test('latency ignores bad clocks and junk', () => {
  const { chain, hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 60, '']);
  const now = () => Number(chain.time);
  const lat = (sentAt) => {
    const r = hb.send(ALICE, 'beat', [sentAt, 'v']);
    chain.advance(60000);
    return r.lat;
  };
  assert.equal(lat(String(now() + 120000)), -1); // sender clock 2 min ahead
  assert.equal(lat(String(now() + 30000)), 0); // slightly ahead: clamp to 0
  assert.equal(lat(String(now() - 2 * HOUR)), -1); // stuck for hours
  assert.equal(lat('not a number'), -1);
  assert.equal(lat(null), -1);
  assert.equal(lat(String(now() - 1234)), 1234);
});

test('version text is cleaned and capped', () => {
  const { chain, hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 60, '']);
  hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v1\n<script>' + 'x'.repeat(50)]);
  const ver = hb.view('getOperator', [ALICE]).ver;
  assert.equal(ver.length, 32);
  assert.ok(!ver.includes('\n'));
});

test('buckets roll over by hour and keep 48 hours', () => {
  const { chain, hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  for (let h = 0; h < 60; h++) {
    for (let k = 0; k < 3; k++) {
      hb.send(ALICE, 'beat', [String(Number(chain.time) - 1000), 'v']);
      chain.advance(HOUR / 3);
    }
  }
  const hist = hb.view('getOperator', [ALICE]).hist;
  assert.equal(hist.length, 48);
  for (let i = 1; i < hist.length; i++) assert.equal(hist[i][0], hist[i - 1][0] + 1);
  const full = hist.slice(1, -1);
  for (const b of full) {
    assert.equal(b[1], 3);
    assert.equal(b[2], 3000);
    assert.equal(b[3], 1000);
    assert.equal(b[4], 3);
  }
  assert.equal(hb.view('getOperator', [ALICE]).beats, 180);
});

test('update changes interval and validator', () => {
  const { hb } = setup();
  assert.throws(() => hb.send(ALICE, 'update', [300, '']), /not registered/);
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  hb.send(ALICE, 'update', [600, VAL]);
  const op = hb.view('getOperator', [ALICE]);
  assert.equal(op.interval, 600);
  assert.equal(op.validator, VAL);
  assert.equal(op.name, 'alpha');
});

test('list pages through operators', () => {
  const { hb } = setup();
  const addrs = Array.from({ length: 7 }, (_, i) => hexAddr(0x1000 + i));
  addrs.forEach((a, i) => hb.send(a, 'register', ['node' + i, 300, '']));
  const p1 = hb.view('list', [0, 5]);
  const p2 = hb.view('list', [5, 5]);
  assert.equal(p1.total, 7);
  assert.deepEqual(p1.items.map((o) => o.name), ['node0', 'node1', 'node2', 'node3', 'node4']);
  assert.deepEqual(p2.items.map((o) => o.name), ['node5', 'node6']);
  assert.ok(Array.isArray(p1.items[0].hist));
  assert.equal(hb.view('list', ['junk', 9999]).items.length, 7);
});

test('unregister swaps the last operator into the gap and frees the name', () => {
  const { hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  hb.send(BOB, 'register', ['beta', 300, '']);
  hb.send(CAROL, 'register', ['gamma', 300, '']);
  hb.send(ALICE, 'unregister');

  const l = hb.view('list', [0, 100]);
  assert.equal(l.total, 2);
  assert.deepEqual(l.items.map((o) => [o.name, o.idx]), [['gamma', 0], ['beta', 1]]);
  assert.equal(hb.view('getOperator', [ALICE]), null);
  assert.equal(hb.view('getByName', ['alpha']), null);
  assert.ok(![...hb.data.keys()].some((k) => k.includes(ALICE.slice(2))));

  hb.send(ALICE, 'register', ['alpha', 300, '']);
  assert.equal(hb.view('getOperator', [ALICE]).idx, 2);
  assert.throws(() => hb.send(hexAddr(0xdead), 'unregister'), /not registered/);
});

test('unregister of the last operator and of the only one', () => {
  const { hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  hb.send(BOB, 'register', ['beta', 300, '']);
  hb.send(BOB, 'unregister');
  assert.deepEqual(hb.view('list', [0, 10]).items.map((o) => o.name), ['alpha']);
  hb.send(ALICE, 'unregister');
  assert.equal(hb.view('list', [0, 10]).total, 0);
  assert.deepEqual([...hb.data.keys()].sort(), ['n', 'owner']);
});

test('owner can remove an operator and hand over ownership', () => {
  const { hb } = setup();
  hb.send(ALICE, 'register', ['spam', 300, '']);
  assert.throws(() => hb.send(BOB, 'removeOperator', [ALICE]), /only the owner/);
  hb.send(OWNER, 'removeOperator', [ALICE.toUpperCase().replace('0X', '0x')]);
  assert.equal(hb.view('info').operators, 0);
  assert.deepEqual(hb.events.at(-1), { name: 'Unregistered', data: { op: ALICE, name: 'spam' } });

  assert.throws(() => hb.send(BOB, 'transferOwnership', [BOB]), /only the owner/);
  assert.throws(() => hb.send(OWNER, 'transferOwnership', ['nope']), /invalid address/);
  hb.send(OWNER, 'transferOwnership', [BOB]);
  assert.equal(hb.view('info').owner, BOB);
  assert.throws(() => hb.send(OWNER, 'removeOperator', [ALICE]), /only the owner/);
});

test('views do not change state', () => {
  const { hb } = setup();
  const before = JSON.stringify([...hb.data]);
  hb.view('info');
  hb.view('list', [0, 10]);
  assert.equal(JSON.stringify([...hb.data]), before);
});

test('storage gas per beat stays modest', () => {
  const { chain, hb } = setup();
  hb.send(ALICE, 'register', ['alpha', 300, '']);
  hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v']);
  chain.advance(300000);
  hb.send(ALICE, 'beat', [String(Number(chain.time)), 'v']);
  assert.ok(hb.gas < 20000, `steady-state beat storage gas ${hb.gas}`);
});
