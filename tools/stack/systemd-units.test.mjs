import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderUnit, UNIT_SPECS } from './systemd-units.mjs';

const CTX = { repo: '/home/dev/whitespace', home: '/home/dev', nodeBinDir: '/opt/node/bin' };
const specByName = (name) => UNIT_SPECS.find((s) => s.name === name);
const render = (name) => renderUnit(specByName(name), CTX);

test('every unit restarts forever — the whole point of "never fall"', () => {
  for (const spec of UNIT_SPECS) {
    const u = renderUnit(spec, CTX);
    assert.match(u, /^Restart=always$/m, `${spec.name} must Restart=always`);
    assert.match(u, /^RestartSec=5$/m, `${spec.name} must set RestartSec`);
  }
});

test('units install into the --user target, not the system one', () => {
  for (const spec of UNIT_SPECS) {
    const u = renderUnit(spec, CTX);
    assert.match(u, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(u, /multi-user\.target/, `${spec.name} is a --user unit`);
  }
});

test('no placeholder token survives into a rendered unit', () => {
  for (const spec of UNIT_SPECS) {
    const u = renderUnit(spec, CTX);
    assert.doesNotMatch(u, /\{node\}|\{repo\}/, `${spec.name} left a token unresolved`);
  }
});

test('placeholders resolve to the absolute node binary and repo root', () => {
  const keeper = render('keeper');
  assert.match(keeper, /^ExecStart=\/opt\/node\/bin\/node src\/main\.mjs$/m);
  assert.match(keeper, /^WorkingDirectory=\/home\/dev\/whitespace\/services\/keeper$/m);
  assert.match(keeper, /^EnvironmentFile=\/home\/dev\/whitespace\/services\/keeper\/\.env$/m);
});

test('the node bin dir leads PATH so nvm node and the env-node shebangs resolve', () => {
  const api = render('api');
  const pathLine = api.split('\n').find((l) => l.startsWith('Environment=PATH='));
  assert.ok(pathLine, 'a PATH line is present');
  assert.equal(pathLine, 'Environment=PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  assert.ok(pathLine.indexOf('/opt/node/bin') < pathLine.indexOf('/usr/bin'), 'node bin dir comes first');
});

test('a dependency is expressed as both After= and Wants= on the unit that needs it', () => {
  const keeper = render('keeper');
  assert.match(keeper, /^After=network-online\.target whitespace-publisher\.service$/m);
  assert.match(keeper, /^Wants=network-online\.target whitespace-publisher\.service$/m);

  const api = render('api');
  assert.match(api, /^After=network-online\.target whitespace-indexer\.service$/m);
});

test('a service with no dependency waits only on the network', () => {
  const publisher = render('publisher');
  assert.match(publisher, /^After=network-online\.target$/m);
  assert.match(publisher, /^Wants=network-online\.target$/m);
  assert.doesNotMatch(publisher, /whitespace-\w+\.service/, 'publisher depends on no other unit');
});

test('the indexer brings Postgres up best-effort, from the repo root, non-fatally', () => {
  const indexer = render('indexer');
  const pre = indexer.split('\n').find((l) => l.startsWith('ExecStartPre='));
  assert.ok(pre, 'indexer has an ExecStartPre');
  // Leading `-`: a missing/started docker must not block the unit.
  assert.match(pre, /^ExecStartPre=-\/bin\/sh -c /);
  // `cd {repo}` because docker-compose.yml is at the root, not in services/indexer.
  assert.match(pre, /cd \/home\/dev\/whitespace && docker compose up -d postgres/);
});

test('only the indexer runs a pre-start; the others do not', () => {
  for (const name of ['api', 'publisher', 'keeper']) {
    assert.doesNotMatch(render(name), /^ExecStartPre=/m, `${name} needs no pre-start`);
  }
});

test('ExecStart for indexer and api uses the repo-local binaries', () => {
  assert.match(render('indexer'), /^ExecStart=\/home\/dev\/whitespace\/services\/indexer\/node_modules\/\.bin\/ponder start --port 42069$/m);
  assert.match(render('api'), /^ExecStart=\/home\/dev\/whitespace\/services\/api\/node_modules\/\.bin\/tsx src\/server\.ts$/m);
});

test('HOME is set explicitly on every unit', () => {
  for (const spec of UNIT_SPECS) {
    assert.match(renderUnit(spec, CTX), /^Environment=HOME=\/home\/dev$/m, `${spec.name} must set HOME`);
  }
});
