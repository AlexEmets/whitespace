// deploy/indexer-schema.sh names the Ponder build schema after the last commit touching the
// indexer's inputs, so a change there gets a fresh schema and anything else does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/indexer-schema.sh');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const run = (repo) => execFileSync('bash', [script, repo], { encoding: 'utf8' }).trim();

function repoWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'idxschema-'));
  git(dir, 'init', '-q');
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('names the schema after the last commit touching the indexer, as a valid identifier', () => {
  const dir = repoWith({ 'services/indexer/a.ts': '1', 'apps/web/b.ts': '1' });
  const name = run(dir);
  assert.match(name, /^ws1874_[0-9a-f]{10}$/);
  assert.equal(name, `ws1874_${git(dir, 'log', '-1', '--format=%h', '--abbrev=10')}`);
});

test('a commit elsewhere keeps the schema; an indexer, shared or manifest commit changes it', () => {
  const dir = repoWith({ 'services/indexer/a.ts': '1', 'apps/web/b.ts': '1', 'packages/shared/c.mjs': '1', 'deployments/1874.json': '{}' });
  const first = run(dir);
  writeFileSync(path.join(dir, 'apps/web/b.ts'), '2');
  git(dir, 'commit', '-qam', 'web');
  assert.equal(run(dir), first, 'a web-only change must not force a resync');
  for (const f of ['services/indexer/a.ts', 'packages/shared/c.mjs', 'deployments/1874.json']) {
    const before = run(dir);
    writeFileSync(path.join(dir, f), `changed ${f}`);
    git(dir, 'commit', '-qam', f);
    assert.notEqual(run(dir), before, `${f} must force a new schema`);
  }
});

test('fails loudly when nothing touches the indexer', () => {
  const dir = repoWith({ 'apps/web/b.ts': '1' });
  assert.throws(() => execFileSync('bash', [script, dir], { stdio: 'pipe' }));
});
