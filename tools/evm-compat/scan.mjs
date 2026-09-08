#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN = { 0x5c: 'TLOAD', 0x5d: 'TSTORE', 0x5e: 'MCOPY' };
const PUSH1 = 0x60;
const PUSH32 = 0x7f;

/**
 * Linear-sweep disassembly that skips PUSH immediate data.
 * @param {string} hex bytecode, with or without a leading 0x
 * @returns {Array<{offset:number, opcode:string}>}
 */
export function scanBytecode(hex) {
  const clean = String(hex ?? '').replace(/^0x/i, '');
  if (clean.length === 0) return [];
  const code = Buffer.from(clean, 'hex');
  const found = [];
  let i = 0;
  while (i < code.length) {
    const op = code[i];
    if (FORBIDDEN[op] !== undefined) found.push({ offset: i, opcode: FORBIDDEN[op] });
    i += op >= PUSH1 && op <= PUSH32 ? 1 + (op - PUSH1 + 1) : 1;
  }
  return found;
}

function* walkJson(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkJson(full);
    else if (entry.endsWith('.json')) yield full;
  }
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: scan.mjs <forge-out-dir>');
    process.exit(2);
  }
  let scanned = 0;
  const violations = [];
  const unreadable = [];
  for (const file of walkJson(dir)) {
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // Do NOT swallow this. A corrupt or half-written artifact that drops out silently
      // narrows the gate's own scope without saying so, which is indistinguishable from
      // a genuine pass. Report it and fail — see the `scanned === 0` floor below for the
      // same reasoning applied to the degenerate case.
      unreadable.push(`${file}: ${err.message}`);
      continue;
    }
    for (const key of ['bytecode', 'deployedBytecode']) {
      const object = artifact?.[key]?.object;
      if (typeof object !== 'string' || object.length <= 2) continue;
      scanned += 1;
      for (const hit of scanBytecode(object)) {
        violations.push(`${file} [${key}] offset ${hit.offset}: ${hit.opcode}`);
      }
    }
  }

  let failed = false;
  if (violations.length > 0) {
    console.error('EVM COMPAT GATE FAILED — Cancun opcodes found:');
    for (const v of violations) console.error('  ' + v);
    console.error('\nWhitechain mainnet 1875 does not implement these. Check evm_version.');
    failed = true;
  }
  if (unreadable.length > 0) {
    console.error('EVM COMPAT GATE FAILED — artifacts could not be parsed:');
    for (const u of unreadable) console.error('  ' + u);
    console.error('\nThe gate cannot certify bytecode it never read. Re-run `forge build`.');
    failed = true;
  }
  // A directory that exists but holds no artifacts satisfies every check above
  // vacuously. `forge clean` (or a changed `out =` path) produces exactly that, and
  // without this floor the gate would report success having inspected nothing.
  if (scanned === 0) {
    console.error(`EVM COMPAT GATE FAILED — no bytecode objects found under ${dir}`);
    console.error('An empty artifact directory passes vacuously. Run `forge build` first.');
    failed = true;
  }
  if (failed) process.exit(1);

  console.log(`evm compat gate OK: ${scanned} bytecode objects, no Cancun opcodes`);
}

// `pathToFileURL` percent-encodes the path exactly the way `import.meta.url` is encoded.
// Comparing against a raw `file://${process.argv[1]}` silently fails to match whenever the
// checkout path contains a space, `#`, or a non-ASCII character — main() would never run and
// the gate would exit 0 having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
