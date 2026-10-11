import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// The 2026-10-09 outage: unbounded logs filled the disk and took Postgres down with them.
test('journald keeps one capped copy and does not duplicate into syslog', () => {
  const conf = read('deploy/journald/whitespace.conf');
  assert.match(conf, /^SystemMaxUse=\d+M$/m);
  assert.match(conf, /^SystemKeepFree=\d+G$/m);
  assert.match(conf, /^ForwardToSyslog=no$/m);
});

test('syslog rotation is bounded by size, not only by time', () => {
  const conf = read('deploy/logrotate/rsyslog');
  assert.match(conf, /\/var\/log\/syslog/);
  assert.match(conf, /^\s*maxsize \d+M$/m);
  assert.match(conf, /^\s*daily$/m);
  assert.match(conf, /^\s*su root syslog$/m, 'without su, logrotate skips every file under a group-writable /var/log');
});

test('the indexer does not log at info on the box', () => {
  const unit = read('deploy/systemd/whitespace-indexer.service');
  assert.match(unit, /^ExecStart=.*ponder start .*--log-level warn/m);
});

// The public RPC limits per source address. The bots and the indexer share the host's IPv4
// one (the provider raised its limit there); the keeper gets the IPv6 one to itself, so their
// bursts cannot make it miss an order's 10 s report window.
const DNS_ORDER = (f) => (f === 'whitespace-keeper.service' ? 'ipv6first' : 'ipv4first');

test('the keeper resolves IPv6 first and every other Node unit IPv4 first', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../systemd/', import.meta.url);
  const units = readdirSync(dir).filter((f) => f.endsWith('.service'));
  const node = units.filter((f) => /NODE_OPTIONS=/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(node.length >= 6, `expected the six Node units, found ${node.join(', ')}`);
  assert.ok(node.includes('whitespace-keeper.service'), 'keeper unit sets NODE_OPTIONS');
  for (const f of node) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    // Quoted as a whole: systemd splits an unquoted Environment= value on spaces, so
    // `Environment=NODE_OPTIONS=--max-old-space-size=64 --dns-result-order=ipv4first` set
    // NODE_OPTIONS to the heap flag alone and dropped the DNS flag — which is what shipped.
    const m = text.match(/^Environment="NODE_OPTIONS=([^"]*)"$/m);
    assert.ok(m, `${f}: NODE_OPTIONS quoted as a whole`);
    const orders = m[1].match(/--dns-result-order=(\S+)/g) ?? [];
    assert.deepEqual(orders, [`--dns-result-order=${DNS_ORDER(f)}`], f);
  }
});
