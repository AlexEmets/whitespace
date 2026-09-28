import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.mjs';

function baseEnv(t) {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pk = generatePrivateKey();
  const keyPath = join(dir, 'signer.json');
  writeFileSync(keyPath, JSON.stringify([{ address: privateKeyToAccount(pk).address, private_key: pk }]));
  return {
    PUBLISHER_VERIFIER_ADDRESS: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    PUBLISHER_SIGNER_KEY_PATHS: keyPath,
  };
}

test('the HTTP server binds to loopback unless told otherwise', (t) => {
  assert.equal(loadConfig(baseEnv(t)).host, '127.0.0.1');
});

test('the signing window defaults to maxAge 10s and 2s skew, and is overridable', (t) => {
  const defaults = loadConfig(baseEnv(t));
  assert.equal(defaults.maxReportAgeS, 10);
  assert.equal(defaults.maxClockSkewS, 2);
  const custom = loadConfig({ ...baseEnv(t), PUBLISHER_MAX_REPORT_AGE_S: '30', PUBLISHER_MAX_CLOCK_SKEW_S: '0' });
  assert.equal(custom.maxReportAgeS, 30);
  assert.equal(custom.maxClockSkewS, 0);
});

test('a malformed signing window is fatal at startup', (t) => {
  assert.throws(() => loadConfig({ ...baseEnv(t), PUBLISHER_MAX_REPORT_AGE_S: 'ten' }), /PUBLISHER_MAX_REPORT_AGE_S/);
  assert.throws(() => loadConfig({ ...baseEnv(t), PUBLISHER_MAX_CLOCK_SKEW_S: '-1' }), /PUBLISHER_MAX_CLOCK_SKEW_S/);
});

test('PUBLISHER_HOST overrides the bind address', (t) => {
  assert.equal(loadConfig({ ...baseEnv(t), PUBLISHER_HOST: '0.0.0.0' }).host, '0.0.0.0');
});
