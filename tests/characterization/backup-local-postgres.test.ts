// ── Characterization: Backup uses PostgresClient abstraction ────────────────
//
// These tests capture the current architecture where pg_dump/psql are
// accessed through the PostgresClient abstraction (Epic 20).
// The POSTGRES_CONTAINER constant now lives in postgres-client.ts
// (LocalPostgresClient), not in backup-runner.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKUP_RUNNER_SRC = resolve(
  __dirname,
  '../../src/services/backup-runner.ts'
);
const PG_CLIENT_SRC = resolve(
  __dirname,
  '../../src/services/postgres-client.ts'
);
const CONFIG_SRC = resolve(__dirname, '../../src/config.ts');

describe('Characterization: backup uses PostgresClient abstraction', () => {
  it('backup-runner.ts imports getPostgresClient', () => {
    const source = readFileSync(BACKUP_RUNNER_SRC, 'utf-8');
    expect(source).toContain('getPostgresClient');
  });

  it('backup-runner.ts does NOT contain hard-coded POSTGRES_CONTAINER', () => {
    const source = readFileSync(BACKUP_RUNNER_SRC, 'utf-8');
    expect(source).not.toContain('POSTGRES_CONTAINER');
  });

  it('backup-runner.ts uses pgClient.spawnPgDump', () => {
    const source = readFileSync(BACKUP_RUNNER_SRC, 'utf-8');
    expect(source).toContain('spawnPgDump');
  });

  it('postgres-client.ts contains POSTGRES_CONTAINER for local mode', () => {
    const source = readFileSync(PG_CLIENT_SRC, 'utf-8');
    expect(source).toContain("const POSTGRES_CONTAINER = 'platform-postgres'");
  });

  it('AgentConfig has role and postgres.mode fields', () => {
    const source = readFileSync(CONFIG_SRC, 'utf-8');
    expect(source).toContain('role');
    expect(source).toContain("mode: 'local' | 'remote'");
  });
});
