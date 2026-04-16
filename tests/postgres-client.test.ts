// ── PostgresClient Tests ────────────────────────────────────────────────────
//
// Tests for the PostgresClient abstraction (local vs remote),
// factory function, and singleton management.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LocalPostgresClient,
  RemotePostgresClient,
  createPostgresClient,
  setPostgresClient,
  getPostgresClient,
  resetPostgresClient,
  type PostgresClientConfig,
  type PostgresClient,
} from '../src/services/postgres-client.js';

// ── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args: unknown[]) => {
    // Return a fake ChildProcess-like object
    return {
      _spawnArgs: args,
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      pid: 12345,
    };
  }),
}));

import { spawn } from 'node:child_process';
const mockSpawn = vi.mocked(spawn);

// ── Mock pg ────────────────────────────────────────────────────────────────

vi.mock('pg', () => {
  const mockPool = {
    query: vi
      .fn()
      .mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return {
    Pool: vi.fn(() => mockPool),
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────────

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

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  resetPostgresClient();
  mockSpawn.mockClear();
});

afterEach(() => {
  resetPostgresClient();
});

// ── Factory tests ──────────────────────────────────────────────────────────

describe('createPostgresClient', () => {
  it('returns LocalPostgresClient for mode=local', () => {
    const client = createPostgresClient(LOCAL_CONFIG);
    expect(client).toBeInstanceOf(LocalPostgresClient);
    expect(client.mode).toBe('local');
  });

  it('returns RemotePostgresClient for mode=remote', () => {
    const client = createPostgresClient(REMOTE_CONFIG);
    expect(client).toBeInstanceOf(RemotePostgresClient);
    expect(client.mode).toBe('remote');
  });
});

// ── LocalPostgresClient ────────────────────────────────────────────────────

describe('LocalPostgresClient', () => {
  let client: LocalPostgresClient;

  beforeEach(() => {
    client = new LocalPostgresClient(LOCAL_CONFIG);
  });

  it('getConnectionInfo returns local mode', () => {
    const info = client.getConnectionInfo();
    expect(info).toEqual({
      mode: 'local',
      host: 'platform-postgres',
      port: 5432,
    });
  });

  it('query delegates to pool', async () => {
    const result = await client.query('SELECT 1');
    expect(result.rows).toBeDefined();
  });

  it('getPool returns the pool instance', () => {
    const pool = client.getPool();
    expect(pool).toBeDefined();
    expect(pool.query).toBeDefined();
  });

  it('isAvailable returns true when pool responds', async () => {
    expect(await client.isAvailable()).toBe(true);
  });

  it('spawnPgDump uses docker exec', () => {
    client.spawnPgDump('mydb');
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        'platform-postgres',
        'pg_dump',
        '-U',
        'platform',
        '--clean',
        '--if-exists',
        'mydb',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });

  it('spawnPgDump passes extraArgs before database', () => {
    client.spawnPgDump('mydb', ['--format=custom']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        'platform-postgres',
        'pg_dump',
        '-U',
        'platform',
        '--clean',
        '--if-exists',
        '--format=custom',
        'mydb',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });

  it('spawnPsql uses docker exec -i', () => {
    client.spawnPsql('mydb');
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        '-i',
        'platform-postgres',
        'psql',
        '-U',
        'platform',
        '-d',
        'mydb',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  it('spawnPsql passes extraArgs', () => {
    client.spawnPsql('mydb', ['-c', 'DROP SCHEMA public CASCADE;']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        '-i',
        'platform-postgres',
        'psql',
        '-U',
        'platform',
        '-d',
        'mydb',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'DROP SCHEMA public CASCADE;',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  it('close ends the pool', async () => {
    await client.close();
    expect(client.getPool().end).toHaveBeenCalled();
  });
});

// ── RemotePostgresClient ───────────────────────────────────────────────────

describe('RemotePostgresClient', () => {
  let client: RemotePostgresClient;

  beforeEach(() => {
    client = new RemotePostgresClient(REMOTE_CONFIG);
  });

  it('getConnectionInfo returns remote mode', () => {
    const info = client.getConnectionInfo();
    expect(info).toEqual({ mode: 'remote', host: '10.114.0.5', port: 5432 });
  });

  it('query delegates to pool', async () => {
    const result = await client.query('SELECT 1');
    expect(result.rows).toBeDefined();
  });

  it('isAvailable returns true when pool responds', async () => {
    expect(await client.isAvailable()).toBe(true);
  });

  it('spawnPgDump uses native pg_dump with host and PGPASSWORD', () => {
    client.spawnPgDump('mydb');
    expect(mockSpawn).toHaveBeenCalledWith(
      'pg_dump',
      [
        '-h',
        '10.114.0.5',
        '-p',
        '5432',
        '-U',
        'platform',
        '--clean',
        '--if-exists',
        'mydb',
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ PGPASSWORD: 'remote-secret' }),
      })
    );
  });

  it('spawnPsql uses native psql with host and PGPASSWORD', () => {
    client.spawnPsql('mydb');
    expect(mockSpawn).toHaveBeenCalledWith(
      'psql',
      [
        '-h',
        '10.114.0.5',
        '-p',
        '5432',
        '-U',
        'platform',
        '-d',
        'mydb',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ PGPASSWORD: 'remote-secret' }),
      })
    );
  });

  it('close ends the pool', async () => {
    await client.close();
    expect(client.getPool().end).toHaveBeenCalled();
  });
});

// ── Singleton management ───────────────────────────────────────────────────

describe('singleton management', () => {
  it('getPostgresClient throws when not initialized', () => {
    expect(() => getPostgresClient()).toThrow('PostgresClient not initialized');
  });

  it('setPostgresClient + getPostgresClient returns the client', () => {
    const client = createPostgresClient(LOCAL_CONFIG);
    setPostgresClient(client);
    expect(getPostgresClient()).toBe(client);
  });

  it('resetPostgresClient clears the singleton', () => {
    setPostgresClient(createPostgresClient(LOCAL_CONFIG));
    resetPostgresClient();
    expect(() => getPostgresClient()).toThrow('PostgresClient not initialized');
  });

  it('setPostgresClient replaces previous client', () => {
    const client1 = createPostgresClient(LOCAL_CONFIG);
    const client2 = createPostgresClient(REMOTE_CONFIG);
    setPostgresClient(client1);
    setPostgresClient(client2);
    expect(getPostgresClient()).toBe(client2);
    expect(getPostgresClient().mode).toBe('remote');
  });
});
