import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointLabel, createEndpointProbes } from '../src/rpc.mjs';

test('endpointLabel keeps scheme and host and drops a path/query API key', () => {
  assert.equal(endpointLabel('https://rpc.example.com/v2/SECRETKEY?x=1'), 'https://rpc.example.com');
  assert.equal(endpointLabel('http://127.0.0.1:4000/main/evm/1874'), 'http://127.0.0.1:4000');
});

test('endpointLabel does not throw on garbage', () => {
  assert.equal(endpointLabel('not a url'), 'invalid-url');
});

test('createEndpointProbes returns one probe per url, in order', () => {
  const probes = createEndpointProbes(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  assert.deepEqual(
    probes.map((p) => p.url),
    ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
  );
  assert.equal(typeof probes[0].getHead, 'function');
});

test('createClients folds concurrent contract reads into one Multicall3 eth_call', async () => {
  const { createServer } = await import('node:http');
  const { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi } = await import('viem');
  const { createClients, whitechainTestnet1874 } = await import('../src/rpc.mjs');
  const abi = parseAbi(['function value(uint256 i) view returns (uint256)']);
  const target = '0x00000000000000000000000000000000000000aa';
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = [JSON.parse(body)].flat();
      const replies = msgs.map((m) => {
        calls.push(m);
        if (m.method !== 'eth_call') return { jsonrpc: '2.0', id: m.id, result: '0x1' };
        const { to, data } = m.params[0];
        if (to.toLowerCase() !== whitechainTestnet1874.contracts.multicall3.address.toLowerCase()) {
          const { args } = decodeFunctionData({ abi, data });
          return { jsonrpc: '2.0', id: m.id, result: encodeFunctionResult({ abi, functionName: 'value', result: args[0] * 10n }) };
        }
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const results = args[0].map((c) => ({
          success: true,
          returnData: encodeFunctionResult({ abi, functionName: 'value', result: decodeFunctionData({ abi, data: c.callData }).args[0] * 10n }),
        }));
        return { jsonrpc: '2.0', id: m.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) };
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? replies : replies[0]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { publicClient } = createClients({ rpcUrls: [url], forwarderPrivateKey: `0x${'11'.repeat(32)}` });
    const values = await Promise.all([1n, 2n, 3n, 4n, 5n].map((i) => publicClient.readContract({ address: target, abi, functionName: 'value', args: [i] })));
    assert.deepEqual(values, [10n, 20n, 30n, 40n, 50n]);
    const ethCalls = calls.filter((c) => c.method === 'eth_call');
    assert.equal(ethCalls.length, 1);
    assert.equal(ethCalls[0].params[0].to.toLowerCase(), whitechainTestnet1874.contracts.multicall3.address.toLowerCase());
  } finally {
    server.close();
  }
});
