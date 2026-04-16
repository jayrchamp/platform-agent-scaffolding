// ── Characterization: Backup assumes local PostgreSQL ───────────────────────
//
// These tests capture the current assumption that pg_dump runs via
// `docker exec platform-postgres`. When epic 20 introduces PostgresClient
// abstraction with remote connections, these tests document the "before" state.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read source files to assert architectural constants.
// This is a characterization test — it captures the current design, not
// runtime behavior.

const AGENT_SRC = resolve(__dirname, '../../src/services/backup-runner.ts');
const CONFIG_SRC = resolve(__dirname, '../../src/config.ts');

describe('Characterization: backup uses local postgres container', () => {
  it('backup-runner.ts exports POSTGRES_CONTAINER = "platform-postgres"', () => {
    const source = readFileSync(AGENT_SRC, 'utf-8');
    expect(source).toContain("const POSTGRES_CONTAINER = 'platform-postgres'");
  });

  it('backup-runner.ts uses docker exec with POSTGRES_CONTAINER for pg_dump', () => {
    const source = readFileSync(AGENT_SRC, 'utf-8');
    expect(source).toContain("'docker'");
    expect(source).toContain("'exec',");
    expect(source).toContain('POSTGRES_CONTAINER,');
    expect(source).toContain("'pg_dump',");
  });

  it('backup-runner.ts uses config.postgres.user for pg_dump -U', () => {
    const source = readFileSync(AGENT_SRC, 'utf-8');
    expect(source).toContain('config.postgres.user');
  });

  it('AgentConfig has a postgres section with host/port/user/password', () => {
    const source = readFileSync(CONFIG_SRC, 'utf-8');
    expect(source).toContain('postgres');
    expect(source).toContain('host');
    expect(source).toContain('port');
    expect(source).toContain('user');
    expect(source).toContain('password');
  });
});
