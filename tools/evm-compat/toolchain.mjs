#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const EXPECTED = { solc: '0.8.24', evm_version: 'shanghai', bytecode_hash: 'none', cbor_metadata: false, via_ir: true };

const path = process.argv[2];
if (!path) {
  console.error('usage: toolchain.mjs <forge-config-json>');
  process.exit(2);
}
const config = JSON.parse(readFileSync(path, 'utf8'));
const problems = [];
for (const [key, want] of Object.entries(EXPECTED)) {
  if (config[key] !== want) problems.push(`${key} is ${config[key]}, expected ${want}`);
}
if (problems.length > 0) {
  console.error('TOOLCHAIN GATE FAILED:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('toolchain gate OK: solc 0.8.24 / shanghai / no metadata');
