// The production box is 2 GB of RAM (1909 MB usable) shared by Postgres, eRPC and eight
// Node processes. Their limits live in three places — docker-compose.yml, the systemd units
// and the connection pool sizes in code — and were never checked against each other: the
// unit MemoryMax values alone summed past physical RAM, Postgres had no limit and stock
// settings, and the kernel OOM killer settled it by killing Postgres, which put production
// in a crash-recovery loop. This test is the arithmetic, so the next change that breaks it
// fails here instead of on the box.
//
// Run: node --test deploy/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');

/** Usable RAM measured on the box (`free -m`), and the share the budget may claim. */
const PHYSICAL_RAM_MB = 1909;
const SOFT_BUDGET_MB = 1700;

/** Long-running units, with how many instances of each run (bot@a and bot@b). */
const LONG_RUNNING = {
  'whitespace-api.service': 1,
  'whitespace-indexer.service': 1,
  'whitespace-web.service': 1,
  'whitespace-publisher.service': 1,
  'whitespace-keeper.service': 1,
  'whitespace-bot@.service': 2,
};

function mb(value) {
  const m = /^(\d+)([MmGg])$/.exec(value);
  assert.ok(m, `unparseable size ${value}`);
  return Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1);
}

function unitDirective(text, key) {
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

function units() {
  return Object.entries(LONG_RUNNING).map(([name, instances]) => {
    const text = read(`deploy/systemd/${name}`);
    const high = unitDirective(text, 'MemoryHigh');
    const max = unitDirective(text, 'MemoryMax');
    const heap = /NODE_OPTIONS=--max-old-space-size=(\d+)/.exec(text);
    return {
      name,
      instances,
      high: high && mb(high),
      max: max && mb(max),
      heap: heap && Number(heap[1]),
    };
  });
}

/** The block of one compose service, up to the next top-level service key. */
function composeService(name) {
  const text = read('docker-compose.yml');
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `compose service ${name} not found`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n  [a-z][\w-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function composeValue(block, key) {
  const m = new RegExp(`^    ${key}: *(.+)$`, 'm').exec(block);
  return m ? m[1].trim() : null;
}

function containerLimitsMb() {
  return ['postgres', 'erpc'].map((svc) => {
    const limit = composeValue(composeService(svc), 'mem_limit');
    assert.ok(limit, `${svc} has no mem_limit`);
    return mb(limit);
  });
}

test('every long-running unit is listed here (a new unit must join the budget)', () => {
  const services = readdirSync(path.join(repo, 'deploy/systemd')).filter((f) => f.endsWith('.service'));
  const oneshots = services.filter((f) => /^Type=oneshot$/m.test(read(`deploy/systemd/${f}`)));
  assert.deepEqual(services.filter((f) => !oneshots.includes(f)).sort(), Object.keys(LONG_RUNNING).sort());
});

test('each Node unit caps its heap under MemoryHigh, and MemoryHigh under MemoryMax', () => {
  for (const u of units()) {
    assert.ok(u.high && u.max && u.heap, `${u.name} needs MemoryHigh, MemoryMax and --max-old-space-size`);
    assert.ok(u.heap < u.high, `${u.name}: heap ${u.heap} MB must sit below MemoryHigh ${u.high} MB`);
    assert.ok(u.high < u.max, `${u.name}: MemoryHigh ${u.high} MB must sit below MemoryMax ${u.max} MB`);
  }
});

test('the hard limits together fit in physical RAM', () => {
  const unitsMax = units().reduce((sum, u) => sum + u.max * u.instances, 0);
  const containers = containerLimitsMb().reduce((a, b) => a + b, 0);
  const total = unitsMax + containers;
  assert.ok(total <= PHYSICAL_RAM_MB, `MemoryMax sum ${unitsMax} MB + containers ${containers} MB = ${total} MB > ${PHYSICAL_RAM_MB} MB`);
});

test(`the soft limits together stay within ${SOFT_BUDGET_MB} MB`, () => {
  const unitsHigh = units().reduce((sum, u) => sum + u.high * u.instances, 0);
  const containers = containerLimitsMb().reduce((a, b) => a + b, 0);
  const total = unitsHigh + containers;
  assert.ok(total <= SOFT_BUDGET_MB, `MemoryHigh sum ${unitsHigh} MB + containers ${containers} MB = ${total} MB > ${SOFT_BUDGET_MB} MB`);
});

test('Postgres is tuned, limited, and the last thing the OOM killer picks', () => {
  const pg = composeService('postgres');
  const oom = Number(composeValue(pg, 'oom_score_adj'));
  assert.ok(oom <= -500, `oom_score_adj ${oom} must make Postgres the last victim`);
  assert.ok(composeValue(pg, 'shm_size'), 'shm_size must be set');
  const memLimit = mb(composeValue(pg, 'mem_limit'));
  const swapLimit = composeValue(pg, 'memswap_limit');
  assert.ok(swapLimit && mb(swapLimit) > memLimit, 'memswap_limit must leave Postgres room to page rather than be OOM-killed');
  for (const setting of ['max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size']) {
    assert.match(pg, new RegExp(`- ${setting}=`), `postgres command must set ${setting}`);
  }
  const sharedBuffers = mb(/- shared_buffers=(\d+)MB/.exec(pg)[1] + 'M');
  assert.ok(sharedBuffers * 3 <= memLimit, `shared_buffers ${sharedBuffers} MB leaves too little of mem_limit ${memLimit} MB for backends`);
});

test('the clients connection pools fit inside max_connections', () => {
  const maxConnections = Number(/- max_connections=(\d+)/.exec(composeService('postgres'))[1]);
  const ponder = Number(/const DEFAULT_DB_POOL_MAX = (\d+);/.exec(read('services/indexer/ponder.config.ts'))[1]);
  const api = Number(/positiveIntEnv\(env, 'PG_POOL_MAX', (\d+)\)/.exec(read('services/api/src/db.ts'))[1]);
  // pgPoolOptions() in candidateSource.mjs is what main.mjs hands to new pg.Pool.
  const bot = Number(/export function pgPoolOptions[\s\S]*?max: (\d+)/.exec(read('services/liquidator/src/candidateSource.mjs'))[1]);
  const reserved = 3 + 2; // superuser_reserved_connections + psql / backup sessions
  const total = ponder + api + bot * LONG_RUNNING['whitespace-bot@.service'] + reserved;
  assert.ok(total <= maxConnections, `pools need ${total} connections, max_connections is ${maxConnections}`);
  assert.ok(ponder < 30, "Ponder's default of 30 must be overridden");
});

test('eRPC runs a pinned release, not latest', () => {
  const image = composeValue(composeService('erpc'), 'image');
  assert.match(image, /^ghcr\.io\/erpc\/erpc:\d+\.\d+\.\d+$/);
});
