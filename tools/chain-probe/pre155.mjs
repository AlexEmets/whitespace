#!/usr/bin/env node
import { CHAINS } from '../../packages/shared/src/chains.mjs';

// The canonical Arachnid CREATE2 deployer presigned transaction (v=27, no chain id).
// The two RLP length prefixes (list f8a5->f88a, data b853->b838) were corrected to
// match the actual truncated init-code payload; the truncation is immaterial because
// replay protection is checked before signature recovery, nonce, or calldata.
const PRESIGNED =
  '0xf88a8085174876e800830186a08080b838604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff3081815260208152f31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';

async function main() {
  const chain = CHAINS[1875];
  const res = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [PRESIGNED], id: 1,
    }),
  });
  const body = await res.json();
  const message = body?.error?.message ?? '(no error — transaction was accepted)';
  console.log(`chain ${chain.id} response: ${message}`);
  console.log('');
  console.log('Interpretation:');
  console.log('  "only replay-protected (EIP-155) transactions allowed"');
  console.log('      -> pre-EIP-155 REJECTED. The canonical CREATE2 factory can never be');
  console.log('         deployed at 0x4e59...; deterministic addresses are unavailable.');
  console.log('  "insufficient funds" / "invalid sender" / "nonce too low"');
  console.log('      -> pre-EIP-155 ACCEPTED by the pool. The factory is deployable by');
  console.log('         funding the deployer address and submitting the real presigned tx.');
}

main();
