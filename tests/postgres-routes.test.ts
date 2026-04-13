// ── PostgreSQL Routes Tests ──────────────────────────────────────────────────
//
// Tests all postgres module HTTP routes via Fastify's inject().
// Mocks pg.Pool via setPgPool / resetPgPool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import type { AgentConfig } from '../src/config.js';

const TOKEN = 'test-postgres-routes-token';
const authHeaders = { authorization: `Bearer ${TOKEN}` };

const testConfig: AgentConfig = {
  port: 0,
  host: '127.0.0.1',
  authToken: TOKEN,
  version: '1.0.0-test',
  statePath: '/tmp/platform-test-pg',
  logLevel: 'error',
  rateLimitMax: 1000,
  postgres: {
    host: 'localhost',
    port: 5432,
    user: 'platform',
    password: 'test-password',
  },
};

// ── Mock pool builder ──────────────────────────────────────────────────────

function mockPool(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>): Pool {
  return { query: vi.fn().mockImplementation(queryImpl) } as unknown as Pool;
}

// ── App setup ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  // Provide a minimal mock so buildApp doesn't throw on initPostgres
  setPgPool(mockPool(async () => ({ rows: [] })));
  app = await buildApp(testConfig);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetPgPool();
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/postgres/databases' });
    expect(res.statusCode).toBe(401);
  });
});

// ── Story 6.1 — Databases ─────────────────────────────────────────────────

describe('GET /api/postgres/databases', () => {
  it('returns list of databases', async () => {
    setPgPool(mockPool(async () => ({
      rows: [
        { datname: 'myapp', owner: 'myapp_user', size_bytes: '10485760', datconnlimit: -1 },
      ],
    })));

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/databases',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.databases).toHaveLength(1);
    expect(body.databases[0].name).toBe('myapp');
    expect(body.databases[0].sizeMb).toBe(10);
  });
});

describe('POST /api/postgres/databases', () => {
  it('rejects missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/databases',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name is required/);
  });

  it('returns dry run result when dryRun=true', async () => {
    // dryRun: check existence returns false
    setPgPool(mockPool(async () => ({ rows: [{ exists: false }] })));

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/databases',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'test_db', dryRun: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.sql).toContain('CREATE DATABASE "test_db"');
    expect(Array.isArray(body.steps)).toBe(true);
  });

  it('creates database when dryRun=false', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // CREATE DATABASE
      .mockResolvedValueOnce({
        rows: [{ datname: 'new_db', owner: 'platform', size_bytes: '8192', datconnlimit: -1 }],
      });
    setPgPool({ query: mockQuery } as unknown as Pool);

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/databases',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'new_db' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('new_db');
  });
});

describe('DELETE /api/postgres/databases/:name', () => {
  it('returns dry run result when ?dryRun=true', async () => {
    let callIndex = 0;
    setPgPool(mockPool(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ exists: true }] };
      return { rows: [{ count: '0' }] };
    }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/postgres/databases/old_db?dryRun=true',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.sql).toContain('DROP DATABASE "old_db"');
  });

  it('returns 204 on successful drop', async () => {
    setPgPool(mockPool(async () => ({ rows: [] })));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/postgres/databases/old_db',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(204);
  });
});

// ── Story 6.2 — Users ─────────────────────────────────────────────────────

describe('GET /api/postgres/users', () => {
  it('returns list of users', async () => {
    setPgPool(mockPool(async () => ({
      rows: [
        { rolname: 'app_user', rolsuper: false, rolcreatedb: false, rolcanlogin: true, rolconnlimit: -1, rolvaliduntil: null },
      ],
    })));

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/users',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].username).toBe('app_user');
  });
});

describe('POST /api/postgres/users', () => {
  it('rejects missing username', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { privilege: 'readonly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/username is required/);
  });

  it('rejects invalid privilege', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { username: 'testuser', privilege: 'superadmin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/privilege must be one of/);
  });

  it('returns dry run result when dryRun=true', async () => {
    setPgPool(mockPool(async () => ({ rows: [{ exists: false }] })));

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { username: 'new_user', privilege: 'readonly', dryRun: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
  });

  it('rejects missing password when not dry run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { username: 'new_user', privilege: 'readonly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password is required/);
  });

  it('creates user with 201 when all params valid', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ rolname: 'new_user', rolsuper: false, rolcreatedb: false, rolcanlogin: true, rolconnlimit: -1, rolvaliduntil: null }],
    });
    setPgPool({ query: mockQuery } as unknown as Pool);

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { username: 'new_user', password: 'super-strong-password-here', privilege: 'readonly' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().username).toBe('new_user');
  });
});

describe('POST /api/postgres/users/:username/rotate-password', () => {
  it('rejects short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users/myuser/rotate-password',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/16 characters/);
  });

  it('rotates password successfully', async () => {
    setPgPool(mockPool(async () => ({ rows: [] })));

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/users/myuser/rotate-password',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { newPassword: 'a-very-strong-new-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('rotated');
  });
});

// ── Story 6.4 — Health ────────────────────────────────────────────────────

describe('GET /api/postgres/health', () => {
  it('returns health when PG responds', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 16.2 on x86_64' }] })
      .mockResolvedValueOnce({ rows: [{ uptime: '1 day 00:00:00' }] })
      .mockResolvedValueOnce({ rows: [{ active: '3', idle: '5', idle_tx: '0', waiting: '0', total: '8', max_conn: '100' }] })
      .mockResolvedValueOnce({ rows: [{ ratio: '97.30' }] })
      .mockResolvedValueOnce({ rows: [{ commits: '5000', rollbacks: '10' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });

    setPgPool({ query: mockQuery } as unknown as Pool);

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isRunning).toBe(true);
    expect(body.version).toContain('PostgreSQL');
    expect(body.connections.total).toBe(8);
    expect(body.cacheHitRatio).toBe(97.3);
  });

  it('returns degraded health when PG is unreachable', async () => {
    setPgPool(mockPool(async () => { throw new Error('ECONNREFUSED'); }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200); // degraded, not 500
    const body = res.json();
    expect(body.isRunning).toBe(false);
    expect(body.error).toContain('ECONNREFUSED');
  });
});

// ── Story 6.5 — Connection History ────────────────────────────────────────

describe('GET /api/postgres/connections/history', () => {
  it('returns history and recommendations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/connections/history',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.history)).toBe(true);
    expect(Array.isArray(body.recommendations)).toBe(true);
  });
});

// ── Story 6.6 — Configuration ─────────────────────────────────────────────

describe('GET /api/postgres/config', () => {
  it('returns managed settings', async () => {
    setPgPool(mockPool(async () => ({
      rows: [
        {
          name: 'max_connections',
          setting: '100',
          unit: '',
          category: 'Connections',
          short_desc: 'Max connections',
          min_val: '1',
          max_val: null,
          reset_val: '100',
          source: 'default',
          pending_restart: false,
        },
      ],
    })));

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/config',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.settings)).toBe(true);
    expect(body.settings[0].name).toBe('max_connections');
  });
});

describe('PATCH /api/postgres/config', () => {
  it('rejects missing fields', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/postgres/config',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'max_connections' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name and value/);
  });

  it('rejects unknown param', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/postgres/config',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'unknown_param', value: '42' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not managed/);
  });

  it('applies a valid setting', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // ALTER SYSTEM SET
      .mockResolvedValueOnce({ rows: [] })  // pg_reload_conf (if no restart required)
      .mockResolvedValueOnce({ rows: [{ pending_restart: false }] });  // check pending_restart

    setPgPool({ query: mockQuery } as unknown as Pool);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/postgres/config',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'work_mem', value: '16MB' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('work_mem');
    expect(body.message).toContain('applied and reloaded');
  });

  it('indicates restart required for max_connections', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // ALTER SYSTEM SET
      .mockResolvedValueOnce({ rows: [{ pending_restart: true }] });  // check pending_restart

    setPgPool({ query: mockQuery } as unknown as Pool);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/postgres/config',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { name: 'max_connections', value: '200' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requiresRestart).toBe(true);
    expect(body.message).toContain('restart required');
  });
});

describe('GET /api/postgres/config/suggestions', () => {
  it('rejects missing ramMb', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/config/suggestions?vCpus=2',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ramMb/);
  });

  it('returns enriched suggestions with current values', async () => {
    setPgPool(mockPool(async () => ({
      rows: [
        { name: 'shared_buffers', setting: '128', unit: '8kB', category: 'Resource', short_desc: '', min_val: null, max_val: null, reset_val: '128', source: 'default', pending_restart: false },
      ],
    })));

    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/config/suggestions?ramMb=4096&vCpus=2',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ramMb).toBe(4096);
    expect(body.vCpus).toBe(2);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.some((s: { name: string }) => s.name === 'shared_buffers')).toBe(true);
  });
});
