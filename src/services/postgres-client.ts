// ── PostgresClient Abstraction ──────────────────────────────────────────────
//
// Provides a uniform interface for PostgreSQL access regardless of deployment
// mode (local container via Docker, or remote TCP connection).
//
// LocalPostgresClient  – VPS database / full  → docker exec platform-postgres
// RemotePostgresClient – VPS app / worker      → native pg_dump / psql via TCP

import { Pool, type QueryResult } from 'pg';
import { type ChildProcess, spawn } from 'node:child_process';

// ── Types ──────────────────────────────────────────────────────────────────

export type PostgresMode = 'local' | 'remote';

export interface PostgresClientConfig {
  mode: PostgresMode;
  /** 'platform-postgres' (local Docker) or '10.114.0.x' (remote VPC) */
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface PostgresClient {
  readonly mode: PostgresMode;

  /** Query SQL via pool */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  /** Direct pool access for operations that need it */
  getPool(): Pool;

  /** Test connectivity */
  isAvailable(): Promise<boolean>;

  /** Connection info */
  getConnectionInfo(): { mode: PostgresMode; host: string; port: number };

  /**
   * Spawn pg_dump — returns a ChildProcess with streamable stdout.
   * Local:  docker exec platform-postgres pg_dump …
   * Remote: pg_dump -h <host> -p <port> -U <user> …
   */
  spawnPgDump(database: string, extraArgs?: string[]): ChildProcess;

  /**
   * Spawn psql with writable stdin — for restore.
   * Local:  docker exec -i platform-postgres psql …
   * Remote: psql -h <host> -p <port> -U <user> …
   */
  spawnPsql(database: string, extraArgs?: string[]): ChildProcess;

  /** Close pool gracefully */
  close(): Promise<void>;
}

// ── Local implementation (VPS database / full) ─────────────────────────────

const POSTGRES_CONTAINER = 'platform-postgres';

export class LocalPostgresClient implements PostgresClient {
  readonly mode: PostgresMode = 'local';
  private pool: Pool;
  private readonly config: PostgresClientConfig;

  constructor(config: PostgresClientConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: 'postgres',
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(sql, params);
  }

  getPool(): Pool {
    return this.pool;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  getConnectionInfo() {
    return { mode: this.mode, host: this.config.host, port: this.config.port };
  }

  spawnPgDump(database: string, extraArgs: string[] = []): ChildProcess {
    return spawn(
      'docker',
      [
        'exec',
        POSTGRES_CONTAINER,
        'pg_dump',
        '-U',
        this.config.user,
        '--clean',
        '--if-exists',
        ...extraArgs,
        database,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }

  spawnPsql(database: string, extraArgs: string[] = []): ChildProcess {
    return spawn(
      'docker',
      [
        'exec',
        '-i',
        POSTGRES_CONTAINER,
        'psql',
        '-U',
        this.config.user,
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
        ...extraArgs,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── Remote implementation (VPS app / worker) ───────────────────────────────

export class RemotePostgresClient implements PostgresClient {
  readonly mode: PostgresMode = 'remote';
  private pool: Pool;
  private readonly config: PostgresClientConfig;

  constructor(config: PostgresClientConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: 'postgres',
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(sql, params);
  }

  getPool(): Pool {
    return this.pool;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  getConnectionInfo() {
    return { mode: this.mode, host: this.config.host, port: this.config.port };
  }

  spawnPgDump(database: string, extraArgs: string[] = []): ChildProcess {
    return spawn(
      'pg_dump',
      [
        '-h',
        this.config.host,
        '-p',
        String(this.config.port),
        '-U',
        this.config.user,
        '--clean',
        '--if-exists',
        ...extraArgs,
        database,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: this.config.password },
      }
    );
  }

  spawnPsql(database: string, extraArgs: string[] = []): ChildProcess {
    return spawn(
      'psql',
      [
        '-h',
        this.config.host,
        '-p',
        String(this.config.port),
        '-U',
        this.config.user,
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
        ...extraArgs,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: this.config.password },
      }
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createPostgresClient(
  config: PostgresClientConfig
): PostgresClient {
  if (config.mode === 'local') {
    return new LocalPostgresClient(config);
  }
  return new RemotePostgresClient(config);
}

// ── Singleton (injectable for tests) ───────────────────────────────────────

let currentClient: PostgresClient | null = null;

export function setPostgresClient(client: PostgresClient): void {
  currentClient = client;
}

export function getPostgresClient(): PostgresClient {
  if (!currentClient) {
    throw new Error(
      'PostgresClient not initialized. Call setPostgresClient() first.'
    );
  }
  return currentClient;
}

export function resetPostgresClient(): void {
  currentClient = null;
}
