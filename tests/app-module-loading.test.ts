// ── Module Loading Tests ────────────────────────────────────────────────────
//
// Verifies that the agent loads the correct modules based on its role.
// Each role has a specific set of modules that should be active.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import { resetPostgresClient } from '../src/services/postgres-client.js';
import type { AgentConfig, ServerRole } from '../src/config.js';

const AUTH_TOKEN = 'test-module-loading-token';

function makeConfig(role: ServerRole, tmpDir: string): AgentConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    authToken: AUTH_TOKEN,
    version: '1.0.0-test',
    statePath: tmpDir,
    logLevel: 'error',
    rateLimitMax: 1000,
    role,
    postgres: {
      mode: 'local',
      host: 'localhost',
      port: 5432,
      user: 'platform',
      password: '',
    },
  };
}

function authHeaders() {
  return { authorization: `Bearer ${AUTH_TOKEN}` };
}

// ── Role: full ─────────────────────────────────────────────────────────────

describe('Agent role=full', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-role-full-'));
    setPgPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    app = await buildApp(makeConfig('full', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPgPool();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads all 10 modules', () => {
    expect(app.loadedModules).toHaveLength(10);
    expect(app.loadedModules).toEqual(
      expect.arrayContaining([
        'system',
        'docker',
        'state',
        'auth',
        'agent',
        'network',
        'postgres',
        'apps',
        'traefik',
        'backup',
      ])
    );
  });

  it('agentRole is full', () => {
    expect(app.agentRole).toBe('full');
  });

  it('health returns role', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().role).toBe('full');
  });

  it('postgres endpoints are accessible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders(),
    });
    expect(res.statusCode).not.toBe(404);
  });

  it('apps endpoints are accessible (not 404 at module level)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/testapp/deploy',
      headers: authHeaders(),
    });
    // Handler sends 404 with "AppSpec not found" — module IS loaded
    const body = res.json();
    expect(body.error).toMatch(/AppSpec/);
  });

  it('backup endpoints are accessible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/history',
      headers: authHeaders(),
    });
    expect(res.statusCode).not.toBe(404);
  });
});

// ── Role: database ─────────────────────────────────────────────────────────

describe('Agent role=database', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-role-db-'));
    setPgPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    app = await buildApp(makeConfig('database', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPgPool();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads 8 modules (no apps, no traefik)', () => {
    expect(app.loadedModules).toHaveLength(8);
    expect(app.loadedModules).toContain('postgres');
    expect(app.loadedModules).toContain('backup');
    expect(app.loadedModules).not.toContain('apps');
    expect(app.loadedModules).not.toContain('traefik');
  });

  it('postgres endpoints are accessible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders(),
    });
    expect(res.statusCode).not.toBe(404);
  });

  it('apps endpoints return 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/testapp/deploy',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('traefik endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Role: app ──────────────────────────────────────────────────────────────

describe('Agent role=app', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-role-app-'));
    // No postgres setup needed — module won't be loaded
    app = await buildApp(makeConfig('app', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads 8 modules (no postgres, no backup)', () => {
    expect(app.loadedModules).toHaveLength(8);
    expect(app.loadedModules).toContain('apps');
    expect(app.loadedModules).toContain('traefik');
    expect(app.loadedModules).not.toContain('postgres');
    expect(app.loadedModules).not.toContain('backup');
  });

  it('postgres endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('backup endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/history',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('apps endpoints are accessible (module loaded)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/testapp/deploy',
      headers: authHeaders(),
    });
    // The handler returns 404 with "AppSpec 'testapp' not found" — module IS loaded
    // If module was NOT loaded, Fastify would return "Route POST:/api/apps/testapp/deploy not found"
    const body = res.json();
    expect(body.error).toMatch(/AppSpec/);
  });
});

// ── Role: worker ───────────────────────────────────────────────────────────

describe('Agent role=worker', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-role-worker-'));
    app = await buildApp(makeConfig('worker', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads 6 modules (universal only)', () => {
    expect(app.loadedModules).toHaveLength(6);
    expect(app.loadedModules).toEqual(
      expect.arrayContaining([
        'system',
        'docker',
        'state',
        'auth',
        'agent',
        'network',
      ])
    );
    expect(app.loadedModules).not.toContain('postgres');
    expect(app.loadedModules).not.toContain('apps');
    expect(app.loadedModules).not.toContain('traefik');
    expect(app.loadedModules).not.toContain('backup');
  });

  it('postgres endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('apps endpoints return 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/testapp/deploy',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('backup endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/history',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('system endpoints still work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers: authHeaders(),
    });
    expect(res.statusCode).not.toBe(404);
  });
});

// ── Default role ───────────────────────────────────────────────────────────

describe('Agent with no role specified', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-role-default-'));
    setPgPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    // Pass config without role field (backward compat)
    const config = {
      port: 0,
      host: '127.0.0.1',
      authToken: AUTH_TOKEN,
      version: '1.0.0-test',
      statePath: tmpDir,
      logLevel: 'error' as const,
      rateLimitMax: 1000,
      postgres: {
        host: 'localhost',
        port: 5432,
        user: 'platform',
        password: '',
      },
    } as AgentConfig;
    app = await buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPgPool();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to full role', () => {
    expect(app.agentRole).toBe('full');
  });

  it('loads all 10 modules', () => {
    expect(app.loadedModules).toHaveLength(10);
  });
});
