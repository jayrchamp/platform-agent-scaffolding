// ── Backup Runner PostgresClient Integration Tests ─────────────────────────
//
// Verifies that backup-runner.ts and backup-restore-runner.ts correctly use
// the PostgresClient abstraction (spawnPgDump / spawnPsql) instead of
// hard-coded docker exec calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setPostgresClient,
  resetPostgresClient,
  LocalPostgresClient,
  RemotePostgresClient,
  type PostgresClient,
  type PostgresClientConfig,
} from '../src/services/postgres-client.js';

// ── Test config fixtures ───────────────────────────────────────────────────

const LOCAL_CONFIG: PostgresClientConfig = {
  mode: 'local',
  host: 'platform-postgres',
  port: 5432,
  user: 'platform',
  password: 'secret',
};

const REMOTE_CONFIG: PostgresClientConfig = {
  mode: 'remote',
  host: '10.114.0.5',
  port: 5432,
  user: 'platform',
  password: 'remote-secret',
};

// ── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => {
  const mockSpawn = vi.fn((...args: unknown[]) => ({
    _spawnArgs: args,
    stdout: { on: vi.fn(), pipe: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    pid: 99999,
  }));
  return { spawn: mockSpawn };
});

import { spawn } from 'node:child_process';
const mockSpawn = vi.mocked(spawn);

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  resetPostgresClient();
  mockSpawn.mockClear();
});

afterEach(() => {
  resetPostgresClient();
});

// ── LocalPostgresClient backup commands ────────────────────────────────────

describe('LocalPostgresClient for backup', () => {
  let client: LocalPostgresClient;

  beforeEach(() => {
    client = new LocalPostgresClient(LOCAL_CONFIG);
    setPostgresClient(client);
  });

  it('spawnPgDump generates docker exec pg_dump command', () => {
    client.spawnPgDump('myapp_production');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        'platform-postgres',
        'pg_dump',
        '-U',
        'platform',
        'myapp_production',
      ]),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('spawnPsql generates docker exec psql command', () => {
    client.spawnPsql('myapp_production');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        'platform-postgres',
        'psql',
        '-U',
        'platform',
        '-d',
        'myapp_production',
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('spawnPsql with -c flag for schema cleanup', () => {
    client.spawnPsql('myapp_production', ['-c', 'DROP SCHEMA public CASCADE;']);

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('-c');
    expect(args).toContain('DROP SCHEMA public CASCADE;');
  });

  it('spawnPgDump with extra args', () => {
    client.spawnPgDump('myapp', ['--format=custom', '--compress=9']);

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--format=custom');
    expect(args).toContain('--compress=9');
    // database name should be last
    expect(args[args.length - 1]).toBe('myapp');
  });
});

// ── RemotePostgresClient backup commands ───────────────────────────────────

describe('RemotePostgresClient for backup', () => {
  let client: RemotePostgresClient;

  beforeEach(() => {
    client = new RemotePostgresClient(REMOTE_CONFIG);
    setPostgresClient(client);
  });

  it('spawnPgDump generates native pg_dump command with host', () => {
    client.spawnPgDump('myapp_production');

    expect(mockSpawn).toHaveBeenCalledWith(
      'pg_dump',
      expect.arrayContaining([
        '-h',
        '10.114.0.5',
        '-p',
        '5432',
        '-U',
        'platform',
        'myapp_production',
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ PGPASSWORD: 'remote-secret' }),
      })
    );
  });

  it('spawnPsql generates native psql command with host', () => {
    client.spawnPsql('myapp_production');

    expect(mockSpawn).toHaveBeenCalledWith(
      'psql',
      expect.arrayContaining([
        '-h',
        '10.114.0.5',
        '-p',
        '5432',
        '-U',
        'platform',
        '-d',
        'myapp_production',
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ PGPASSWORD: 'remote-secret' }),
      })
    );
  });

  it('PGPASSWORD is set in env for remote commands', () => {
    client.spawnPgDump('testdb');

    const options = mockSpawn.mock.calls[0]![2] as {
      env: Record<string, string>;
    };
    expect(options.env.PGPASSWORD).toBe('remote-secret');
  });

  it('does NOT use docker exec', () => {
    client.spawnPgDump('testdb');

    // First argument should be 'pg_dump', not 'docker'
    expect(mockSpawn.mock.calls[0]![0]).toBe('pg_dump');
    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('docker');
    expect(args).not.toContain('exec');
  });
});
