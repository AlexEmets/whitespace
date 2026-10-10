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

// The raised RPC rate limit is keyed on the host's IPv4 address; over IPv6 every service was
// still on the shared 50 rps limit, and the keeper's polls kept coming back rate-limited.
test('every Node unit resolves IPv4 first', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../systemd/', import.meta.url);
  const units = readdirSync(dir).filter((f) => f.endsWith('.service'));
  const node = units.filter((f) => /NODE_OPTIONS=/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(node.length >= 6, `expected the six Node units, found ${node.join(', ')}`);
  for (const f of node) {
    // Quoted as a whole: systemd splits an unquoted Environment= value on spaces, so
    // `Environment=NODE_OPTIONS=--max-old-space-size=64 --dns-result-order=ipv4first` set
    // NODE_OPTIONS to the heap flag alone and dropped the IPv4 flag — which is what shipped.
    assert.match(readFileSync(new URL(f, dir), 'utf8'), /^Environment="NODE_OPTIONS=[^"]*--dns-result-order=ipv4first[^"]*"$/m, f);
  }
});
