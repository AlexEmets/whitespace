// Runs the real deploy/deploy.sh against a scratch clone, with sudo, systemctl and pnpm
// replaced by stubs that record what they were asked to do. Proves the recovery and
// restart-on-change rules without a server.
//
// Run: node --test deploy/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_SH = path.resolve(here, '../deploy.sh');
const INDEXER_SCHEMA_SH = path.resolve(here, '../indexer-schema.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
}

function write(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode) chmodSync(file, mode);
}

const STUBS = {
  // Logs every call; `sudo systemctl <verb> <unit>` fails when "<verb> <unit>" is in FAKE_FAIL.
  sudo: `#!/usr/bin/env bash
echo "sudo $*" >> "$FAKE_LOG"
if [ "$1" = systemctl ] && [ -n "\${FAKE_FAIL:-}" ] && [ "$2 $3" = "$FAKE_FAIL" ]; then exit 1; fi
exit 0
`,
  systemctl: `#!/usr/bin/env bash
case "$1" in
  show) echo "2099-01-01 00:00:00 UTC" ;;
  is-active) echo active ;;
esac
`,
  // install fails when FAKE_INSTALL_FAIL=1; build fails when FAKE_BUILD_FAIL=1, else writes BUILD_ID.
  pnpm: `#!/usr/bin/env bash
echo "pnpm $*" >> "$FAKE_LOG"
if [ "$1" = install ] && [ "\${FAKE_INSTALL_FAIL:-0}" = 1 ]; then exit 1; fi
if [ "\${!#}" = build ]; then
  [ "\${FAKE_BUILD_FAIL:-0}" = 1 ] && exit 1
  mkdir -p apps/web/.next && date +%s > apps/web/.next/BUILD_ID
fi
exit 0
`,
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-sh-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  const state = path.join(root, 'state');

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  write(path.join(work, 'deploy/indexer-schema.sh'), readFileSync(INDEXER_SCHEMA_SH, 'utf8'), 0o755);
  for (const f of ['services/indexer/a', 'services/price-publisher/a', 'services/keeper/a', 'packages/shared/a', 'apps/web/a']) {
    write(path.join(work, f), 'v1\n');
  }
  write(path.join(work, 'deploy/systemd/whitespace-api.service'), '[Service]\n');
  write(path.join(work, 'deploy/systemd/whitespace-keeper.service'), '[Service]\n');
  write(path.join(work, 'deploy/systemd/whitespace-backup.timer'), '[Timer]\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, repo);

  for (const [name, body] of Object.entries(STUBS)) write(path.join(bin, name), body, 0o755);

  const commit = (file, text = `${Date.now()}-${Math.random()}\n`) => {
    write(path.join(work, file), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `change ${file}`);
    git(work, 'push', '-q', 'origin', 'main');
  };

  const deploy = (env = {}) => {
    rmSync(log, { force: true });
    const r = spawnSync('bash', [DEPLOY_SH], {
      encoding: 'utf8',
      env: {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        WHITESPACE_REPO: repo,
        WHITESPACE_DEPLOY_STATE: state,
        WHITESPACE_VERIFY_DELAY_S: '0',
        FAKE_LOG: log,
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { code: r.status, out: r.stdout, err: r.stderr, calls };
  };

  return { root, repo, commit, deploy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const restarted = (calls, unit) => calls.includes(`sudo systemctl restart ${unit}`);
const started = (calls, unit) => calls.includes(`sudo systemctl start ${unit}`);

test('a first deploy installs the units and restarts everything, web and indexer after the build', () => {
  const f = fixture();
  try {
    const r = f.deploy();
    assert.equal(r.code, 0, r.err);
    assert.ok(r.calls.includes('sudo cp deploy/systemd/whitespace-api.service /etc/systemd/system/whitespace-api.service'));
    assert.ok(r.calls.includes('sudo cp deploy/systemd/whitespace-backup.timer /etc/systemd/system/whitespace-backup.timer'));
    assert.ok(r.calls.indexOf('sudo systemctl daemon-reload') > r.calls.lastIndexOf('sudo cp deploy/systemd/whitespace-keeper.service /etc/systemd/system/whitespace-keeper.service'));
    for (const unit of ['whitespace-publisher', 'whitespace-keeper', 'whitespace-api', 'whitespace-bot@a', 'whitespace-bot@b']) {
      assert.ok(restarted(r.calls, unit), `${unit} restarted`);
    }
    const build = r.calls.indexOf('pnpm --filter @whitespace/web build');
    assert.ok(r.calls.indexOf('sudo systemctl stop whitespace-web') < build);
    assert.ok(r.calls.indexOf('sudo systemctl start whitespace-web') > build);
    assert.ok(started(r.calls, 'whitespace-indexer'));
  } finally {
    f.cleanup();
  }
});

test('a web-only change leaves publisher and keeper running and does not reinstall units', () => {
  const f = fixture();
  try {
    assert.equal(f.deploy().code, 0);
    f.commit('apps/web/a');
    const r = f.deploy();
    assert.equal(r.code, 0, r.err);
    assert.equal(restarted(r.calls, 'whitespace-publisher'), false);
    assert.equal(restarted(r.calls, 'whitespace-keeper'), false);
    assert.equal(r.calls.includes('sudo systemctl daemon-reload'), false);
    assert.ok(restarted(r.calls, 'whitespace-api'));
    assert.match(r.out, /whitespace-publisher: nothing it runs changed/);
  } finally {
    f.cleanup();
  }
});

test('a publisher change restarts the publisher only; a shared package change restarts both', () => {
  const f = fixture();
  try {
    assert.equal(f.deploy().code, 0);
    f.commit('services/price-publisher/a');
    let r = f.deploy();
    assert.equal(r.code, 0, r.err);
    assert.equal(restarted(r.calls, 'whitespace-publisher'), true);
    assert.equal(restarted(r.calls, 'whitespace-keeper'), false);

    f.commit('packages/shared/a');
    r = f.deploy();
    assert.equal(restarted(r.calls, 'whitespace-publisher'), true);
    assert.equal(restarted(r.calls, 'whitespace-keeper'), true);
  } finally {
    f.cleanup();
  }
});

test('a changed unit file is installed and reloaded, and restarts the unit it defines', () => {
  const f = fixture();
  try {
    assert.equal(f.deploy().code, 0);
    f.commit('deploy/systemd/whitespace-keeper.service', '[Service]\nMemoryMax=104M\n');
    let r = f.deploy();
    assert.equal(r.code, 0, r.err);
    assert.ok(r.calls.includes('sudo cp deploy/systemd/whitespace-keeper.service /etc/systemd/system/whitespace-keeper.service'));
    assert.ok(r.calls.includes('sudo systemctl daemon-reload'));
    assert.ok(r.calls.indexOf('sudo systemctl daemon-reload') < r.calls.indexOf('sudo systemctl restart whitespace-keeper'));
    assert.equal(restarted(r.calls, 'whitespace-publisher'), false);
    // Installed once: an unchanged tree does not reinstall.
    r = f.deploy();
    assert.equal(r.calls.includes('sudo systemctl daemon-reload'), false);
  } finally {
    f.cleanup();
  }
});

test('a failed build brings the indexer back and refuses to start web on an empty tree', () => {
  const f = fixture();
  try {
    const r = f.deploy({ FAKE_BUILD_FAIL: '1' });
    assert.notEqual(r.code, 0);
    assert.ok(started(r.calls, 'whitespace-indexer'), 'the indexer must not be left stopped');
    assert.equal(started(r.calls, 'whitespace-web'), false);
    assert.match(r.err, /whitespace-web NOT started/);
  } finally {
    f.cleanup();
  }
});

test('a failure after the build brings both web and indexer back', () => {
  const f = fixture();
  try {
    const r = f.deploy({ FAKE_FAIL: 'restart whitespace-api' });
    assert.notEqual(r.code, 0);
    assert.ok(started(r.calls, 'whitespace-indexer'));
    assert.ok(started(r.calls, 'whitespace-web'));
    assert.match(r.err, /bringing them back/);
  } finally {
    f.cleanup();
  }
});

test('a failure before anything was stopped starts nothing (boundary)', () => {
  const f = fixture();
  try {
    const r = f.deploy({ FAKE_INSTALL_FAIL: '1' });
    assert.notEqual(r.code, 0);
    assert.equal(r.calls.some((c) => c.startsWith('sudo systemctl')), false);
  } finally {
    f.cleanup();
  }
});

test('a deploy that failed before restarting the publisher still restarts it on the next run', () => {
  const f = fixture();
  try {
    assert.equal(f.deploy().code, 0);
    f.commit('services/price-publisher/a');
    // Pulls the change, then fails before the restart step.
    assert.notEqual(f.deploy({ FAKE_BUILD_FAIL: '1' }).code, 0);
    // Nothing new to pull this time, but the publisher is still running the old code.
    const r = f.deploy();
    assert.equal(r.code, 0, r.err);
    assert.equal(restarted(r.calls, 'whitespace-publisher'), true);
    assert.equal(restarted(r.calls, 'whitespace-keeper'), false);
  } finally {
    f.cleanup();
  }
});
