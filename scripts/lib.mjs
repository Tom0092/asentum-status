// Shared helpers for the deploy script and the heartbeat sender.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsentumClient, AsentumWallet, DEFAULT_RPC } from '@asentum/sdk';

export const CRON_REGISTRY = 'ase1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxgkr943'; // 0x…06, ARC-21

export function makeClient(rpc) {
  return new AsentumClient(rpc || process.env.ASENTUM_RPC || DEFAULT_RPC, { retries: 3, requestTimeoutMs: 20000 });
}

// Key files are JSON { address, publicKeyHex, secretKeyHex }, mode 0600.
export function createKeyFile(client, path, { force = false } = {}) {
  if (existsSync(path) && !force) throw new Error(`${path} already exists; refusing to overwrite (pass --force to replace it)`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const wallet = AsentumWallet.create(client);
  const data = {
    address: wallet.address,
    publicKeyHex: wallet.publicKeyHex,
    secretKeyHex: wallet.secretKeyHex,
    created: new Date().toISOString(),
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return wallet;
}

export function loadWallet(client, path) {
  if (!existsSync(path)) throw new Error(`key file ${path} not found (create one with keygen)`);
  const mode = statSync(path).mode & 0o777;
  if (process.platform !== 'win32' && mode & 0o077) {
    throw new Error(`key file ${path} is readable by others (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
  }
  const k = JSON.parse(readFileSync(path, 'utf8'));
  if (!k.secretKeyHex || !k.publicKeyHex) throw new Error(`key file ${path} has no secretKeyHex/publicKeyHex`);
  const wallet = AsentumWallet.fromSecretKey(client, k.secretKeyHex, k.publicKeyHex, { keyless: 'auto' });
  if (k.address && k.address !== wallet.address) throw new Error(`key file ${path}: address does not match the keys`);
  return wallet;
}

// The status page config (site/config.js) is an ES module with a default export.
export async function readSiteConfig(path) {
  if (!existsSync(path)) return {};
  const mod = await import(`${new URL(`file://${path}`).href}?t=${Date.now()}`);
  return { ...(mod.default || {}) };
}

export function writeSiteConfig(path, cfg) {
  const body = `// Written by scripts/deploy.mjs. Every value can be overridden in the URL:
//   ?rpc=https://...&registry=ase1...&canary=ase1...
// Add ?demo to see the page with made-up data.
export default ${JSON.stringify(cfg, null, 2)};
`;
  writeFileSync(path, body);
}

export function parseReturn(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function describeError(e) {
  if (!e) return 'unknown error';
  const parts = [e.message || String(e)];
  if (e.reason && !parts[0].includes(e.reason)) parts.push(`reason: ${e.reason}`);
  if (e.receipt?.error) parts.push(`receipt: ${e.receipt.error}`);
  if (e.cause?.message) parts.push(`cause: ${e.cause.message}`);
  return parts.join('; ');
}
