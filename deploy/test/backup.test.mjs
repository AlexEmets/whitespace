import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = readFileSync(new URL('../systemd/whitespace-backup.service', import.meta.url), 'utf8');
const script = readFileSync(new URL('../backup-api-series.sh', import.meta.url), 'utf8');

test('the backup unit hands its destination to the user it runs as, before it runs', () => {
  const user = unit.match(/^User=(\S+)$/m)?.[1];
  const group = unit.match(/^Group=(\S+)$/m)?.[1];
  const dest = script.match(/^DEST=(\S+)$/m)?.[1];
  assert.ok(user && group && dest, 'unit names a user and group, script a DEST');
  const pre = unit.match(/^ExecStartPre=(.*)$/m)?.[1];
  assert.ok(pre, 'an ExecStartPre prepares the destination');
  // Root ("+"), because the service user cannot take over a root-owned directory itself.
  assert.ok(pre.startsWith('+'), 'the step runs with full privileges');
  assert.match(pre, new RegExp(`install -d -o ${user} -g ${group} (-m \\d+ )?${dest.replace(/\//g, '\\/')}$`));
});
