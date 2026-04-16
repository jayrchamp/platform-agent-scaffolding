// ── Agent Role Integration Tests ────────────────────────────────────────────
//
// End-to-end integration tests that verify each role produces a fully
// functional agent with the correct module set. Covers non-regression
// for role=full, endpoint isolation for all roles, and PostgresClient
// initialization behavior.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import {
  resetPostgresClient,
  getPostgresClient,
} from '../src/services/postgres-client.js';
import type { AgentConfig, ServerRole } from '../src/config.js';

const TOKEN = 'integration-test-token';
const headers = { authorization: `Bearer ${TOKEN}` };

function makeConfig(role: ServerRole, tmpDir: string): AgentConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    authToken: TOKEN,
    version: '3.0.0-integration',
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
    appServers: [],
  };
}

// ── Full role: non-regression ──────────────────────────────────────────────

describe('Integration: role=full (non-regression)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'int-full-'));
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

  it('all 10 modules loaded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    const body = res.json();
    expect(body.modules).toHaveLength(10);
    expect(body.features.postgres).toBe(true);
    expect(body.features.apps).toBe(true);
    expect(body.features.backup).toBe(true);
    expect(body.features.traefik).toBe(true);
  });

  it('health endpoint works without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().role).toBe('full');
  });

  it('postgres health endpoint accessible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers,
    });
    // Will return an error (no real PG) but NOT 404
    expect(res.statusCode).not.toBe(404);
  });

  it('backup scheduler status accessible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/scheduler/status',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('running');
  });

  it('agent version includes role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/version',
      headers,
    });
    expect(res.json().role).toBe('full');
    expect(res.json().version).toBe('3.0.0-integration');
  });

  it('PostgresClient is initialized', () => {
    expect(() => getPostgresClient()).not.toThrow();
    expect(getPostgresClient().mode).toBe('local');
  });
});

// ── Database role ──────────────────────────────────────────────────────────

describe('Integration: role=database', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'int-db-'));
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

  it('postgres endpoints work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers,
    });
    expect(res.statusCode).not.toBe(404);
  });

  it('backup scheduler works', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/scheduler/status',
      headers,
    });
    expect(res.statusCode).toBe(200);
  });

  it('apps/deploy returns 404 (module not loaded)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/testapp/deploy',
      headers,
    });
    // Fastify router 404, not handler 404
    expect(res.json().message).toMatch(/not found/i);
  });

  it('traefik returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('PostgresClient is initialized', () => {
    expect(() => getPostgresClient()).not.toThrow();
  });
});

// ── App role ───────────────────────────────────────────────────────────────

describe('Integration: role=app', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'int-app-'));
    // Reset any existing client from previous test suites
    resetPostgresClient();
    app = await buildApp(makeConfig('app', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('apps module is loaded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    expect(res.json().features.apps).toBe(true);
  });

  it('traefik module is loaded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    expect(res.json().features.traefik).toBe(true);
  });

  it('postgres endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/postgres/health',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('backup endpoints return 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/backup/scheduler/status',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('PostgresClient is NOT initialized for app role', () => {
    // getPostgresClient should throw since app role doesn't init it
    expect(() => getPostgresClient()).toThrow('PostgresClient not initialized');
  });

  it('system endpoints still work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers,
    });
    expect(res.statusCode).not.toBe(404);
  });
});

// ── Worker role ────────────────────────────────────────────────────────────

describe('Integration: role=worker', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'int-worker-'));
    resetPostgresClient();
    app = await buildApp(makeConfig('worker', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('universal + worker modules loaded (7)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    const body = res.json();
    expect(body.modules).toHaveLength(7);
    expect(body.modules).toContain('worker');
    expect(body.features).toEqual({
      postgres: false,
      apps: false,
      backup: false,
      traefik: false,
    });
  });

  it('all conditional endpoints return 404', async () => {
    const endpoints = [
      { method: 'GET' as const, url: '/api/postgres/health' },
      { method: 'POST' as const, url: '/api/apps/testapp/deploy' },
      { method: 'GET' as const, url: '/api/traefik/routes' },
      { method: 'GET' as const, url: '/api/backup/scheduler/status' },
    ];

    for (const { method, url } of endpoints) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode).toBe(404);
    }
  });

  it('PostgresClient IS initialized for worker role (remote mode)', () => {
    const pgClient = getPostgresClient();
    expect(pgClient).toBeDefined();
  });

  it('docker endpoints still work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docker/containers',
      headers,
    });
    // Will fail (no docker.sock) but not 404
    expect([200, 500]).toContain(res.statusCode);
  });
});

// ── Config defaults ────────────────────────────────────────────────────────

describe('Integration: config defaults', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'int-defaults-'));
    setPgPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    // Config without explicit role — should default to 'full'
    const config = {
      port: 0,
      host: '127.0.0.1',
      authToken: TOKEN,
      version: '1.0.0',
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

  it('defaults to full when role is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    expect(res.json().role).toBe('full');
    expect(res.json().modules).toHaveLength(10);
  });
});
