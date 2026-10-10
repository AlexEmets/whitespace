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
});

test('the indexer does not log at info on the box', () => {
  const unit = read('deploy/systemd/whitespace-indexer.service');
  assert.match(unit, /^ExecStart=.*ponder start .*--log-level warn/m);
});
