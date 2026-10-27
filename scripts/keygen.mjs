#!/usr/bin/env node
// Create a deployer wallet: node scripts/keygen.mjs [path] [--force]
// Default path: keys/deployer.json (git-ignored). Fund it with test ASE before deploying.
import { createKeyFile, makeClient } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const path = args.find((a) => !a.startsWith('--')) || 'keys/deployer.json';

try {
  const wallet = createKeyFile(makeClient(), path, { force });
  console.log(`Created ${path}`);
  console.log(`Address: ${wallet.address}`);
  console.log('Back this file up and keep it private. Send test ASE to the address before deploying.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
