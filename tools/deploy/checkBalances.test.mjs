// Drives deploy/check-balances.sh against a fake JSON-RPC server, so the alerting logic
// (floor comparison past 64-bit, unreadable RPC, all-clear) is proven without a chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/check-balances.sh');

function fakeRpc(balances) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { params } = JSON.parse(body);
        const addr = params[0].toLowerCase();
        if (!(addr in balances)) {
          res.writeHead(500).end('boom');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + balances[addr].toString(16) }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script], { env: { PATH: process.env.PATH, DISK_MAX_PERCENT: '100', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

test('all clear when every balance is at or above the floor', async () => {
  const server = await fakeRpc({ [A]: 10n ** 18n, [B]: 2n * 10n ** 16n });
  const { port } = server.address();
  const r = await run({ RPC_URL: `http://127.0.0.1:${port}`, WATCH_ADDRESSES: `keeper=${A} bot-a=${B}` });
  server.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /^ok:/);
});

test('alerts on a balance below the floor, naming the address and amount', async () => {
  const server = await fakeRpc({ [A]: 10n ** 18n, [B]: 10n ** 16n - 1n });
  const { port } = server.address();
  const r = await run({ RPC_URL: `http://127.0.0.1:${port}`, WATCH_ADDRESSES: `keeper=${A} bot-a=${B}` });
  server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /bot-a .* 0\.0100 WBT, below 0\.0200/);
  assert.doesNotMatch(r.err, /keeper/);
  assert.match(r.err, /telegram not configured/);
});

test('compares balances past 64-bit range correctly', async () => {
  const huge = 2n ** 80n;
  const server = await fakeRpc({ [A]: huge });
  const { port } = server.address();
  const r = await run({ RPC_URL: `http://127.0.0.1:${port}`, WATCH_ADDRESSES: `keeper=${A}`, MIN_BALANCE_WEI: (huge - 1n).toString() });
  server.close();
  assert.equal(r.code, 0);
});

test('an unreadable balance is an alert, not a silent pass', async () => {
  const server = await fakeRpc({});
  const { port } = server.address();
  const r = await run({ RPC_URL: `http://127.0.0.1:${port}`, WATCH_ADDRESSES: `keeper=${A}` });
  server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /keeper .*unreadable/);
});

test('alerts when the disk is past its threshold', async () => {
  const r = await run({ WATCH_ADDRESSES: '', DISK_MAX_PERCENT: '0' });
  assert.equal(r.code, 1);
  assert.match(r.err, /disk: \/ is \d+% full/);
});
