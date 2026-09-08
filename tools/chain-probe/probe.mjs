#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { CHAINS } from '../../packages/shared/src/chains.mjs';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// init code that executes one opcode then returns a single byte
const PROBE_MCOPY = '0x60006000600060005e600160005260016000f3';

/** @returns {string[]} human-readable drift descriptions, empty when all match */
export function classifyProbe(observed, expects) {
  const drift = [];
  for (const [key, want] of Object.entries(expects)) {
    const got = observed[key];
    if (got !== want) drift.push(`${key}: expected ${want}, observed ${got}`);
  }
  return drift;
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  return res.json();
}

async function hasCode(url, address) {
  const { result } = await rpc(url, 'eth_getCode', [address, 'latest']);
  return typeof result === 'string' && result !== '0x';
}

async function observe(chain) {
  const block = (await rpc(chain.rpc, 'eth_getBlockByNumber', ['latest', false])).result;
  const mcopy = await rpc(chain.rpc, 'eth_call', [{ data: PROBE_MCOPY }, 'latest']);
  return {
    eip1559: block?.baseFeePerGas != null,
    cancun: mcopy.error === undefined,
    create2Factory: await hasCode(chain.rpc, CREATE2_FACTORY),
    multicall3: await hasCode(chain.rpc, MULTICALL3),
  };
}

async function main() {
  let failed = false;
  for (const chain of Object.values(CHAINS)) {
    let observed;
    try {
      observed = await observe(chain);
    } catch (err) {
      console.error(`${chain.name} (${chain.id}): UNREACHABLE — ${err.message}`);
      failed = true;
      continue;
    }
    const drift = classifyProbe(observed, chain.expects);
    if (drift.length === 0) {
      console.log(`${chain.name} (${chain.id}): OK`);
    } else {
      console.error(`${chain.name} (${chain.id}): DRIFT`);
      for (const d of drift) console.error('  ' + d);
      failed = true;
    }
  }
  if (failed) {
    console.error('\nNetwork capabilities differ from the spec. Update spec §2.1 deliberately.');
    process.exit(1);
  }
}

// `pathToFileURL` percent-encodes the path exactly the way `import.meta.url` is encoded.
// Comparing against a raw `file://${process.argv[1]}` silently fails to match whenever the
// checkout path contains a space, `#`, or a non-ASCII character — main() would never run and
// the probe would exit 0 having contacted nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
