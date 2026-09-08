import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBytecode } from './scan.mjs';

const SCAN = fileURLToPath(new URL('./scan.mjs', import.meta.url));

/** Runs the gate as a real child process so the exit code is the thing under test. */
function runGate(dir, script = SCAN) {
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tempDir(t, prefix = 'scan-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal forge-shaped artifact: PUSH1 0x01, PUSH1 0x00, MSTORE, STOP. */
function writeCleanArtifact(dir, name = 'Clean.json') {
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      bytecode: { object: '0x600160005200' },
      deployedBytecode: { object: '0x600160005200' },
    }),
  );
}

test('accepts bytecode with no Cancun opcodes', () => {
  // PUSH1 0x01, PUSH1 0x00, MSTORE, STOP
  assert.deepEqual(scanBytecode('0x600160005200'), []);
});

test('accepts PUSH0, which is Shanghai and allowed', () => {
  // PUSH0, POP, STOP
  assert.deepEqual(scanBytecode('0x5f5000'), []);
});

test('detects a real TSTORE', () => {
  // PUSH1 0x00, PUSH1 0x00, TSTORE
  assert.deepEqual(scanBytecode('0x600060005d'), [{ offset: 4, opcode: 'TSTORE' }]);
});

test('detects TLOAD and MCOPY', () => {
  assert.deepEqual(scanBytecode('0x5c'), [{ offset: 0, opcode: 'TLOAD' }]);
  assert.deepEqual(scanBytecode('0x5e'), [{ offset: 0, opcode: 'MCOPY' }]);
});

test('does NOT report forbidden bytes inside PUSH immediates', () => {
  // PUSH2 0x5d5d  -> the two 0x5d bytes are data, not opcodes
  assert.deepEqual(scanBytecode('0x615d5d'), []);
});

test('does NOT report a forbidden byte inside PUSH32 immediate data', () => {
  const immediate = '5c'.repeat(32);
  assert.deepEqual(scanBytecode('0x7f' + immediate), []);
});

test('handles a truncated trailing PUSH without throwing', () => {
  // PUSH32 with only one immediate byte present
  assert.deepEqual(scanBytecode('0x7f5c'), []);
});

test('tolerates empty and 0x-only input', () => {
  assert.deepEqual(scanBytecode('0x'), []);
  assert.deepEqual(scanBytecode(''), []);
});

// --- gate-level behaviour: the three ways this gate could report success without
// --- ever having inspected a byte of bytecode.

test('passes and reports the count on a directory holding real artifacts', (t) => {
  const dir = tempDir(t);
  writeCleanArtifact(dir);
  const r = runGate(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /evm compat gate OK: 2 bytecode objects/);
});

test('FAILS on an existing but empty artifact directory', (t) => {
  const dir = tempDir(t);
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no bytecode objects found/);
});

test('FAILS on a directory whose .json files hold no bytecode at all', (t) => {
  const dir = tempDir(t);
  // `forge clean` leaves the tree; a wrong `out =` path points at unrelated JSON.
  writeFileSync(join(dir, 'not-an-artifact.json'), JSON.stringify({ hello: 'world' }));
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no bytecode objects found/);
});

test('FAILS and names the file when an artifact cannot be parsed', (t) => {
  const dir = tempDir(t);
  writeCleanArtifact(dir);
  writeFileSync(join(dir, 'Corrupt.json'), '{"bytecode": {"object": "0x6001');
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be parsed/);
  assert.match(r.stderr, /Corrupt\.json/);
});

test('recurses into subdirectories', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'Nested.sol'));
  writeCleanArtifact(join(dir, 'Nested.sol'));
  const r = runGate(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /evm compat gate OK: 2 bytecode objects/);
});

test('still detects a Cancun opcode through the gate, not just the scanner', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'Bad.json'),
    JSON.stringify({ deployedBytecode: { object: '0x600060005d' } }),
  );
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TSTORE/);
});

test('runs when its own path contains a space (pathToFileURL, not raw concat)', (t) => {
  const home = tempDir(t, 'scan home ');
  assert.ok(home.includes(' '), 'the temp dir name must contain a space for this to prove anything');
  const copied = join(home, 'scan.mjs');
  copyFileSync(SCAN, copied);

  const artifacts = tempDir(t);
  writeCleanArtifact(artifacts);

  const r = runGate(artifacts, copied);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /evm compat gate OK: 2 bytecode objects/);
});
