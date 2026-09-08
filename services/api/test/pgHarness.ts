import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// Spins up a real, throwaway PostgreSQL instance for the test run using the
// `initdb`/`pg_ctl`/`psql` binaries already present on this machine (no
// Docker, no shared/long-lived service). If TEST_DATABASE_URL is set
// (e.g. in CI with a managed Postgres), that is used instead and nothing is
// spawned. Either way, the test suite exercises a REAL Postgres — never a
// mock — because the whole point of these tests is to prove decimal
// precision survives a real NUMERIC round trip through node-postgres.

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('could not allocate a free port'));
      }
    });
    srv.on('error', reject);
  });
}

export type PgHarness = {
  connectionString: string;
  stop: () => void;
};

export async function startEphemeralPostgres(): Promise<PgHarness> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    return { connectionString: external, stop: () => undefined };
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'whitespace-api-pg-'));
  const port = await getFreePort();

  execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-sync'], { stdio: 'ignore' });
  execFileSync(
    'pg_ctl',
    ['-D', dataDir, '-l', join(dataDir, 'pg.log'), '-o', `-p ${port} -k ${dataDir} -h 127.0.0.1`, 'start'],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = spawnSync('pg_isready', ['-h', '127.0.0.1', '-p', String(port)]);
    if (res.status === 0) break;
    if (Date.now() > deadline) {
      throw new Error('ephemeral postgres did not become ready in time');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }

  const dbName = 'whitespace_api_test';
  execFileSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-c', `CREATE DATABASE ${dbName};`], {
    stdio: 'ignore',
  });

  const connectionString = `postgres://postgres@127.0.0.1:${port}/${dbName}`;
  const schemaPath = fileURLToPath(new URL('./fixtures/schema.sql', import.meta.url));
  execFileSync('psql', [connectionString, '-f', schemaPath], { stdio: 'ignore' });

  function stop(): void {
    try {
      execFileSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'immediate'], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return { connectionString, stop };
}
