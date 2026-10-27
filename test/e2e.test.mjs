// End to end: the real deploy script and heartbeat sender, run as child
// processes against the mock node (real SDK signing, real contracts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHexAddress, AsentumWallet, AsentumClient } from '@asentum/sdk';
import { startMockNode, CRON } from './mock-node.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASE = 10n ** 18n;
let node;
let dir;
let alerts;
let alertServer;
let alertUrl;

function run(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

before(async () => {
  node = await startMockNode();
  dir = mkdtempSync(join(tmpdir(), 'asentum-status-'));
  alerts = [];
  alertServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    alerts.push({ title: req.headers.title, body });
    res.end('ok');
  });
  await new Promise((r) => alertServer.listen(0, '127.0.0.1', r));
  alertUrl = `http://127.0.0.1:${alertServer.address().port}/ntfy-test`;
});

after(async () => {
  await node.close();
  await new Promise((r) => alertServer.close(r));
});

test('deploy: registry and canary deployed, canary scheduled, config written, re-run is a no-op', async () => {
  const key = join(dir, 'deployer.json');
  const k = await run('scripts/keygen.mjs', [key], {});
  assert.equal(k.code, 0, k.stderr);
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const deployer = JSON.parse(readFileSync(key, 'utf8')).address;

  const env = {
    ASENTUM_RPC: node.url,
    DEPLOY_KEY: key,
    DEPLOY_STATE: join(dir, 'deploy-state.json'),
    STATUS_CONFIG: join(dir, 'config.js'),
  };

  const poor = await run('scripts/deploy.mjs', [], env);
  assert.equal(poor.code, 1);
  assert.match(poor.stderr, /needs more than 1 ASE/);

  node.fund(deployer, 5n * ASE);
  const d = await run('scripts/deploy.mjs', ['--repo', 'https://github.com/example/asentum-status'], env);
  assert.equal(d.code, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /Done\./);

  const cfg = (await import(`file://${env.STATUS_CONFIG}?x=1`)).default;
  assert.match(cfg.registry, /^ase1/);
  assert.match(cfg.canary, /^ase1/);
  assert.equal(cfg.cronJob, '1');
  assert.equal(cfg.rpc, node.url);
  assert.equal(cfg.repo, 'https://github.com/example/asentum-status');

  const canary = node.contracts.get(toHexAddress(cfg.canary));
  const st = canary.view('status');
  assert.equal(st.owner, toHexAddress(deployer));
  assert.equal(st.cron, CRON);
  assert.equal(st.job, '1');
  const registry = node.contracts.get(toHexAddress(cfg.registry));
  assert.equal(registry.view('info').owner, toHexAddress(deployer));

  // The chain's cron now drives the canary.
  node.advance(5 * 60000);
  const after5 = canary.view('snapshot');
  assert.ok(after5.status.ticks >= 3 && after5.status.ticks <= 4, `ticks ${after5.status.ticks}`);
  assert.equal(after5.status.missed, 0);
  assert.equal(after5.recent.length, after5.status.ticks);

  // A stall shows up as an incident.
  node.chain.advance(8 * 60000, 1);
  node.advance(2000);
  assert.equal(canary.view('incidents').length, 1);

  const txs = node.txLog.length;
  const again = await run('scripts/deploy.mjs', [], env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(node.txLog.length, txs, 'a re-run sends no transactions');

  writeFileSync(join(dir, 'registry.txt'), cfg.registry);
});

test('heartbeat sender: keygen, register, beat, failures, alerts, recovery, unregister', async () => {
  const registry = readFileSync(join(dir, 'registry.txt'), 'utf8');
  const env = {
    HB_RPC: node.url,
    HB_KEYFILE: join(dir, 'hb', 'heartbeat.json'),
    HB_REGISTRY: registry,
    HB_ALERT_URL: alertUrl,
    HB_TIMEOUT_MS: '3000',
  };
  const hb = (...args) => run('sender/heartbeat.mjs', args, env);

  const k = await hb('keygen');
  assert.equal(k.code, 0, k.stderr);
  assert.equal((await hb('keygen')).code, 1, 'refuses to overwrite');
  const addr = JSON.parse(readFileSync(env.HB_KEYFILE, 'utf8')).address;
  node.fund(addr, ASE / 10n);

  const validator = AsentumWallet.create(new AsentumClient(node.url)).address;
  assert.equal((await hb('register', 'tom-node', '--interval', '120', '--validator', 'not-an-address')).code, 1);
  const reg = await hb('register', 'Tom-Node', '--interval', '120', '--validator', validator);
  assert.equal(reg.code, 0, reg.stderr);
  const reg2 = await hb('register', 'other');
  assert.equal(reg2.code, 5);
  assert.match(reg2.stderr, /already registered/);

  const reg3 = node.contracts.get(toHexAddress(registry));
  let op = reg3.view('getOperator', [toHexAddress(addr)]);
  assert.equal(op.name, 'tom-node');
  assert.equal(op.interval, 120);
  assert.equal(op.validator, toHexAddress(validator));

  const b1 = await hb('beat');
  assert.equal(b1.code, 0, b1.stderr);
  assert.match(b1.stdout, /heartbeat landed/);
  op = reg3.view('getOperator', [toHexAddress(addr)]);
  assert.equal(op.beats, 1);
  assert.equal(op.ver, 'asentum-status/1.0.0');
  assert.equal(alerts.length, 0);

  // Too soon: the contract refuses, the sender exits 5 and alerts once.
  const b2 = await hb('beat');
  assert.equal(b2.code, 5);
  assert.match(b2.stderr, /too frequent/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Heartbeat failed');
  const b2b = await hb('beat');
  assert.equal(b2b.code, 5);
  assert.equal(alerts.length, 1, 'no repeat alert while still failing');

  node.advance(60000);
  const b3 = await hb('beat');
  assert.equal(b3.code, 0, b3.stderr);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].title, 'Heartbeat recovered');

  // A node that accepts but never includes: exit 2 (stuck).
  node.advance(60000);
  node.dropTx = true;
  const b4 = await hb('beat');
  node.dropTx = false;
  assert.equal(b4.code, 2);
  assert.match(b4.stderr, /not in a block/);
  assert.equal(alerts.length, 3);

  const s = await hb('status');
  assert.equal(s.code, 0);
  assert.match(s.stdout, /beats\s+2/);

  const u = await hb('unregister');
  assert.equal(u.code, 0, u.stderr);
  assert.equal(reg3.view('getOperator', [toHexAddress(addr)]), null);
  assert.ok(existsSync(join(dir, 'hb', 'heartbeat-state.json')));
});

test('name only: register --no-heartbeat, beat refused, switch heartbeats on later', async () => {
  const registry = readFileSync(join(dir, 'registry.txt'), 'utf8');
  const env = { HB_RPC: node.url, HB_KEYFILE: join(dir, 'named', 'key.json'), HB_REGISTRY: registry, HB_TIMEOUT_MS: '3000' };
  const hb = (...args) => run('sender/heartbeat.mjs', args, env);
  assert.equal((await hb('keygen')).code, 0);
  const addr = JSON.parse(readFileSync(env.HB_KEYFILE, 'utf8')).address;
  node.fund(addr, ASE / 10n);
  const validator = AsentumWallet.create(new AsentumClient(node.url)).address;

  const noVal = await hb('register', 'named-node', '--no-heartbeat');
  assert.equal(noVal.code, 1);
  assert.match(noVal.stderr, /needs --validator/);
  const both = await hb('register', 'named-node', '--no-heartbeat', '--interval', '300', '--validator', validator);
  assert.equal(both.code, 1);

  const reg = await hb('register', 'named-node', '--no-heartbeat', '--validator', validator);
  assert.equal(reg.code, 0, reg.stderr);
  assert.match(reg.stdout, /shows on the status page/);
  const contract = node.contracts.get(toHexAddress(registry));
  assert.equal(contract.view('getByValidator', [toHexAddress(validator)]).name, 'named-node');

  node.advance(60000);
  const beat = await hb('beat');
  assert.equal(beat.code, 5);
  assert.match(beat.stderr, /heartbeats are off/);

  const up = await hb('update', '--interval', '300');
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /heartbeat every 300 s/);
  node.advance(60000);
  assert.equal((await hb('beat')).code, 0);
  const st = await hb('status');
  assert.match(st.stdout, /heartbeat\s+every 300 s/);
});
