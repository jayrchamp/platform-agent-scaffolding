// ── PostgreSQL Service Tests ─────────────────────────────────────────────────
//
// Mocks pg.Pool since there's no PostgreSQL instance in the test environment.
// Each test injects a mock pool via setPgPool / resetPgPool.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import {
  listDatabases,
  createDatabase,
  dropDatabase,
  dryRunCreateDatabase,
  dryRunDropDatabase,
  listUsers,
  createUser,
  dropUser,
  rotatePassword,
  dryRunCreateUser,
  dryRunDropUser,
  getInstanceHealth,
  getPgSettings,
  suggestPgSettings,
  getPoolingRecommendations,
  recordConnectionSample,
  getConnectionHistory,
  clearConnectionHistory,
  setPgPool,
  resetPgPool,
  type ConnectionStats,
} from '../src/services/postgres.js';

// ── Mock Pool builder ──────────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };
type MockQueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

function createMockPool(queryFn: MockQueryFn): Pool {
  return { query: vi.fn().mockImplementation(queryFn) } as unknown as Pool;
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  clearConnectionHistory();
});

afterEach(() => {
  resetPgPool();
});

// ── Story 6.1 — Database CRUD ──────────────────────────────────────────────

describe('listDatabases', () => {
  it('returns mapped database info', async () => {
    setPgPool(createMockPool(async () => ({
      rows: [
        { datname: 'myapp', owner: 'myapp_user', size_bytes: '10485760', datconnlimit: -1 },
        { datname: 'staging', owner: 'platform', size_bytes: '5242880', datconnlimit: 50 },
      ],
    })));

    const dbs = await listDatabases();

    expect(dbs).toHaveLength(2);
    expect(dbs[0]!.name).toBe('myapp');
    expect(dbs[0]!.owner).toBe('myapp_user');
    expect(dbs[0]!.sizeMb).toBe(10);
    expect(dbs[0]!.connectionLimit).toBe(-1);
    expect(dbs[1]!.sizeMb).toBe(5);
  });
});

describe('dryRunCreateDatabase', () => {
  it('returns valid result for a new database name', async () => {
    let callCount = 0;
    setPgPool(createMockPool(async () => {
      callCount++;
      // First call: check existence → false
      return { rows: [{ exists: false }] };
    }));

    const result = await dryRunCreateDatabase('my_new_db');

    expect(result.valid).toBe(true);
    expect(result.sql).toContain('CREATE DATABASE "my_new_db"');
    expect(result.steps.every((s) => s.status !== 'error')).toBe(true);
  });

  it('returns invalid for already existing database', async () => {
    setPgPool(createMockPool(async () => ({
      rows: [{ exists: true }],
    })));

    const result = await dryRunCreateDatabase('existing_db');

    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('already exists'))).toBe(true);
  });

  it('returns invalid for system database name', async () => {
    setPgPool(createMockPool(async () => ({ rows: [] })));

    const result = await dryRunCreateDatabase('postgres');

    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('system database'))).toBe(true);
  });

  it('returns invalid for bad identifier', async () => {
    setPgPool(createMockPool(async () => ({ rows: [] })));

    const result = await dryRunCreateDatabase('123-bad-name');

    expect(result.valid).toBe(false);
  });

  it('includes owner in SQL when provided', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      // call 1: check db exists → false; call 2: check owner exists → true
      return { rows: [{ exists: callIndex === 2 }] };
    }));

    const result = await dryRunCreateDatabase('my_db', 'myuser');

    expect(result.valid).toBe(true);
    expect(result.sql).toContain('OWNER "myuser"');
  });
});

describe('createDatabase', () => {
  it('executes CREATE DATABASE and returns info', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // CREATE DATABASE
      .mockResolvedValueOnce({              // SELECT info
        rows: [{ datname: 'newdb', owner: 'platform', size_bytes: '8192', datconnlimit: -1 }],
      });

    setPgPool({ query: mockQuery } as unknown as Pool);

    const db = await createDatabase('newdb');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0]![0]).toContain('CREATE DATABASE "newdb"');
    expect(db.name).toBe('newdb');
  });
});

describe('dryRunDropDatabase', () => {
  it('returns valid result when database exists with no connections', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: true }] };      // exists check
      return { rows: [{ count: '0' }] };                             // active connections
    }));

    const result = await dryRunDropDatabase('old_db');

    expect(result.valid).toBe(true);
    expect(result.sql).toContain('DROP DATABASE "old_db"');
    expect(result.warnings.some((w) => w.includes('irreversible'))).toBe(true);
  });

  it('warns about active connections', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: true }] };
      return { rows: [{ count: '3' }] };    // 3 active connections
    }));

    const result = await dryRunDropDatabase('busy_db');

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('3 active connection'))).toBe(true);
    const connStep = result.steps.find((s) => s.label.includes('connections'));
    expect(connStep?.status).toBe('warning');
  });

  it('returns invalid when database does not exist', async () => {
    setPgPool(createMockPool(async () => ({
      rows: [{ exists: false }],
    })));

    const result = await dryRunDropDatabase('ghost_db');

    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('does not exist'))).toBe(true);
  });
});

describe('dropDatabase', () => {
  it('executes DROP DATABASE WITH (FORCE)', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    setPgPool({ query: mockQuery } as unknown as Pool);

    await dropDatabase('old_db');

    expect(mockQuery.mock.calls[0]![0]).toContain('DROP DATABASE IF EXISTS "old_db"');
    expect(mockQuery.mock.calls[0]![0]).toContain('FORCE');
  });
});

// ── Story 6.2 — User Management ────────────────────────────────────────────

describe('listUsers', () => {
  it('returns mapped user info', async () => {
    setPgPool(createMockPool(async () => ({
      rows: [
        {
          rolname: 'myapp_user',
          rolsuper: false,
          rolcreatedb: false,
          rolcanlogin: true,
          rolconnlimit: -1,
          rolvaliduntil: null,
        },
      ],
    })));

    const users = await listUsers();

    expect(users).toHaveLength(1);
    expect(users[0]!.username).toBe('myapp_user');
    expect(users[0]!.isSuperuser).toBe(false);
    expect(users[0]!.canLogin).toBe(true);
    expect(users[0]!.validUntil).toBeNull();
  });
});

describe('dryRunCreateUser', () => {
  it('returns valid result for a new username', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      return { rows: [{ exists: callIndex !== 1 }] }; // first call: user doesn't exist
    }));

    const result = await dryRunCreateUser('new_user', 'readwrite');

    expect(result.valid).toBe(true);
    expect(result.steps.every((s) => s.status !== 'error')).toBe(true);
  });

  it('returns invalid for existing username', async () => {
    setPgPool(createMockPool(async () => ({ rows: [{ exists: true }] })));

    const result = await dryRunCreateUser('existing_user', 'readonly');

    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('already exists'))).toBe(true);
  });

  it('returns invalid for system username', async () => {
    setPgPool(createMockPool(async () => ({ rows: [] })));

    const result = await dryRunCreateUser('platform', 'admin');

    expect(result.valid).toBe(false);
  });

  it('warns when target database does not exist', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: false }] }; // user doesn't exist
      return { rows: [{ exists: false }] };                       // db doesn't exist
    }));

    const result = await dryRunCreateUser('new_user', 'readonly', 'nonexistent_db');

    expect(result.valid).toBe(true); // still valid, but with warning
    expect(result.warnings.some((w) => w.includes('does not exist'))).toBe(true);
  });
});

describe('createUser', () => {
  it('executes CREATE ROLE and grants readwrite privileges', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{
        rolname: 'appuser',
        rolsuper: false,
        rolcreatedb: false,
        rolcanlogin: true,
        rolconnlimit: -1,
        rolvaliduntil: null,
      }],
    });
    setPgPool({ query: mockQuery } as unknown as Pool);

    const user = await createUser('appuser', 'pass123', 'readwrite', 'mydb');

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('CREATE ROLE "appuser"'))).toBe(true);
    expect(calls.some((s) => s.includes('GRANT CONNECT ON DATABASE "mydb"'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT, UPDATE, DELETE'))).toBe(true);
    expect(user.username).toBe('appuser');
  });

  it('grants admin privilege with CREATEDB', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{
        rolname: 'admin_user',
        rolsuper: false,
        rolcreatedb: true,
        rolcanlogin: true,
        rolconnlimit: -1,
        rolvaliduntil: null,
      }],
    });
    setPgPool({ query: mockQuery } as unknown as Pool);

    await createUser('admin_user', 'pass', 'admin');

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('ALTER ROLE "admin_user" CREATEDB'))).toBe(true);
  });
});

describe('rotatePassword', () => {
  it('executes ALTER ROLE with new password', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    setPgPool({ query: mockQuery } as unknown as Pool);

    await rotatePassword('myuser', 'new-strong-password-here');

    expect(mockQuery.mock.calls[0]![0]).toContain('ALTER ROLE "myuser" PASSWORD');
  });
});

describe('dryRunDropUser', () => {
  it('returns valid result when user exists with no owned databases', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: true }] };   // user exists
      if (callIndex === 2) return { rows: [{ count: '0' }] };     // no owned DBs
      return { rows: [{ count: '0' }] };                          // no active connections
    }));

    const result = await dryRunDropUser('old_user');

    expect(result.valid).toBe(true);
    expect(result.sql).toContain('DROP ROLE "old_user"');
  });

  it('returns invalid when user owns databases', async () => {
    let callIndex = 0;
    setPgPool(createMockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: true }] };
      return { rows: [{ count: '2' }] };  // owns 2 databases
    }));

    const result = await dryRunDropUser('db_owner');

    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('owns 2 database'))).toBe(true);
  });
});

// ── Story 6.4 — Instance Health ────────────────────────────────────────────

describe('getInstanceHealth', () => {
  it('returns health data from pg_stat queries', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 16.2 on x86_64-pc-linux-musl' }] })  // version
      .mockResolvedValueOnce({ rows: [{ uptime: '2 days 04:30:00' }] })                            // uptime
      .mockResolvedValueOnce({ rows: [{ active: '5', idle: '10', idle_tx: '1', waiting: '0', total: '15', max_conn: '100' }] }) // connections
      .mockResolvedValueOnce({ rows: [{ ratio: '98.50' }] })                                        // cache hit
      .mockResolvedValueOnce({ rows: [{ commits: '12345', rollbacks: '23' }] })                    // transactions
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });                                           // database count

    setPgPool({ query: mockQuery } as unknown as Pool);

    const health = await getInstanceHealth();

    expect(health.isRunning).toBe(true);
    expect(health.version).toBe('PostgreSQL 16.2');
    expect(health.uptime).toBe('2 days 04:30:00');
    expect(health.connections.active).toBe(5);
    expect(health.connections.total).toBe(15);
    expect(health.connections.max).toBe(100);
    expect(health.connections.usagePercent).toBe(15);
    expect(health.cacheHitRatio).toBe(98.5);
    expect(health.transactions.commits).toBe(12345);
    expect(health.databases).toBe(3);
  });
});

// ── Story 6.5 — Connection History ────────────────────────────────────────

describe('connection history', () => {
  it('records and retrieves connection samples', () => {
    const stats: ConnectionStats = { active: 5, idle: 10, idleInTransaction: 0, waiting: 0, total: 15, max: 100, usagePercent: 15 };
    recordConnectionSample(stats);
    recordConnectionSample(stats);

    const history = getConnectionHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.active).toBe(5);
    expect(history[0]!.total).toBe(15);
    expect(history[0]!.max).toBe(100);
    expect(history[0]!.timestamp).toBeTruthy();
  });

  it('caps history at 288 samples', () => {
    const stats: ConnectionStats = { active: 1, idle: 1, idleInTransaction: 0, waiting: 0, total: 2, max: 100, usagePercent: 2 };
    for (let i = 0; i < 300; i++) recordConnectionSample(stats);
    expect(getConnectionHistory()).toHaveLength(288);
  });

  it('clears history', () => {
    const stats: ConnectionStats = { active: 1, idle: 0, idleInTransaction: 0, waiting: 0, total: 1, max: 100, usagePercent: 1 };
    recordConnectionSample(stats);
    clearConnectionHistory();
    expect(getConnectionHistory()).toHaveLength(0);
  });
});

describe('getPoolingRecommendations', () => {
  it('returns empty for empty history', () => {
    expect(getPoolingRecommendations([])).toHaveLength(0);
  });

  it('recommends pgBouncer when usage exceeds 90%', () => {
    const history = [
      { timestamp: new Date().toISOString(), active: 90, total: 92, max: 100 },
    ];
    const recs = getPoolingRecommendations(history);
    expect(recs.some((r) => r.includes('pgBouncer'))).toBe(true);
    expect(recs.some((r) => r.includes('92%') || r.includes('immediately'))).toBe(true);
  });

  it('warns when usage exceeds 70%', () => {
    const history = [
      { timestamp: new Date().toISOString(), active: 72, total: 75, max: 100 },
    ];
    const recs = getPoolingRecommendations(history);
    expect(recs.some((r) => r.includes('75%'))).toBe(true);
  });

  it('returns no warnings for low usage', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(Date.now() - i * 5 * 60_000).toISOString(),
      active: 5,
      total: 8,
      max: 100,
    }));
    const recs = getPoolingRecommendations(history);
    expect(recs).toHaveLength(0);
  });
});

// ── Story 6.6 — Configuration ─────────────────────────────────────────────

describe('getPgSettings', () => {
  it('returns mapped settings from pg_settings', async () => {
    setPgPool(createMockPool(async () => ({
      rows: [
        {
          name: 'max_connections',
          setting: '100',
          unit: '',
          category: 'Connections and Authentication',
          short_desc: 'Sets the maximum number of concurrent connections.',
          min_val: '1',
          max_val: '262143',
          reset_val: '100',
          source: 'default',
          pending_restart: false,
        },
        {
          name: 'shared_buffers',
          setting: '128',
          unit: '8kB',
          category: 'Resource Usage',
          short_desc: 'Sets the number of shared memory buffers used by the server.',
          min_val: '16',
          max_val: null,
          reset_val: '128',
          source: 'default',
          pending_restart: false,
        },
      ],
    })));

    const settings = await getPgSettings(['max_connections', 'shared_buffers']);

    expect(settings).toHaveLength(2);
    expect(settings[0]!.name).toBe('max_connections');
    expect(settings[0]!.requiresRestart).toBe(true);  // max_connections requires restart
    expect(settings[1]!.name).toBe('shared_buffers');
    expect(settings[1]!.requiresRestart).toBe(true);
  });
});

describe('suggestPgSettings', () => {
  it('returns suggestions for a 4GB / 2 vCPU server', () => {
    const suggestions = suggestPgSettings(4096, 2);

    expect(suggestions.length).toBeGreaterThan(5);

    const sharedBuffers = suggestions.find((s) => s.name === 'shared_buffers');
    expect(sharedBuffers?.suggestedValue).toBe('1024MB'); // 25% of 4096

    const effectiveCache = suggestions.find((s) => s.name === 'effective_cache_size');
    expect(effectiveCache?.suggestedValue).toBe('2457MB'); // 60% of 4096

    const maxConns = suggestions.find((s) => s.name === 'max_connections');
    // Math.max(100, 2 vCPUs × 4) = Math.max(100, 8) = 100 (minimum guaranteed)
    expect(maxConns?.suggestedValue).toBe('100');

    const randomPage = suggestions.find((s) => s.name === 'random_page_cost');
    expect(randomPage?.suggestedValue).toBe('1.1');
  });

  it('caps shared_buffers at 8GB for large servers', () => {
    const suggestions = suggestPgSettings(64 * 1024, 16); // 64GB
    const sharedBuffers = suggestions.find((s) => s.name === 'shared_buffers');
    expect(sharedBuffers?.suggestedValue).toBe('8192MB');
  });

  it('caps maintenance_work_mem at 2GB', () => {
    const suggestions = suggestPgSettings(64 * 1024, 16);
    const mwm = suggestions.find((s) => s.name === 'maintenance_work_mem');
    expect(mwm?.suggestedValue).toBe('2048MB');
  });

  it('returns minimum 100 for max_connections', () => {
    const suggestions = suggestPgSettings(1024, 1);
    const maxConns = suggestions.find((s) => s.name === 'max_connections');
    expect(parseInt(maxConns?.suggestedValue ?? '0', 10)).toBeGreaterThanOrEqual(100);
  });
});
