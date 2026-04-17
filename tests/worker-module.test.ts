// ── Worker Module Tests ─────────────────────────────────────────────────────

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
  setPostgresClient,
} from '../src/services/postgres-client.js';
import type { AgentConfig, ServerRole } from '../src/config.js';

const TOKEN = 'worker-module-test-token';
const headers = { authorization: `Bearer ${TOKEN}` };

function makeConfig(
  role: ServerRole,
  tmpDir: string,
  overrides?: Partial<AgentConfig>
): AgentConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    authToken: TOKEN,
    version: '3.0.0-test',
    statePath: tmpDir,
    logLevel: 'error',
    rateLimitMax: 1000,
    role,
    postgres: {
      mode: 'remote',
      host: 'localhost',
      port: 5432,
      user: 'platform',
      password: 'test',
    },
    appServers: [],
    ...overrides,
  };
}

// ── Worker role: module endpoints ──────────────────────────────────────────

describe('Worker module — role=worker', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worker-mod-'));

    // Mock globalThis.fetch to avoid real HTTP calls to app servers
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Not reachable'));

    app = await buildApp(
      makeConfig('worker', tmpDir, {
        appServers: [{ host: '10.114.0.2', port: 3100, name: 'my-app' }],
      })
    );

    // Override the PostgresClient with a mock to avoid real DB connections
    setPostgresClient({
      isAvailable: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      getConnectionInfo: vi.fn().mockReturnValue({
        mode: 'remote',
        host: '10.114.0.3',
        port: 5432,
      }),
    } as any);

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/worker/status returns worker status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worker/status',
      headers,
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.role).toBe('worker');
    expect(body.jobTypes).toEqual([]);
    expect(body).toHaveProperty('database');
    expect(body).toHaveProperty('appServers');
    expect(typeof body.ready).toBe('boolean');
  });

  it('GET /api/worker/jobs returns empty placeholder', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worker/jobs',
      headers,
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.jobs).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.message).toContain('not yet implemented');
  });

  it('GET /api/worker/connectivity returns full diagnostic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worker/connectivity',
      headers,
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toHaveProperty('database');
    expect(body).toHaveProperty('appServers');
    expect(body).toHaveProperty('summary');
    expect(typeof body.summary.dbReachable).toBe('boolean');
    expect(body.summary.appServersTotal).toBe(1);
  });

  it('status includes configured app servers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worker/status',
      headers,
    });
    const body = res.json();
    expect(body.appServers).toHaveLength(1);
    expect(body.appServers[0].name).toBe('my-app');
    expect(body.appServers[0].host).toBe('10.114.0.2');
  });
});

// ── Non-worker roles: endpoints return 404 ────────────────────────────────

describe('Worker module — not loaded for other roles', () => {
  let fullApp: FastifyInstance;
  let appRoleApp: FastifyInstance;
  let tmpDirFull: string;
  let tmpDirApp: string;

  beforeAll(async () => {
    tmpDirFull = mkdtempSync(join(tmpdir(), 'worker-no-full-'));
    setPgPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    fullApp = await buildApp(makeConfig('full', tmpDirFull));
    await fullApp.ready();

    tmpDirApp = mkdtempSync(join(tmpdir(), 'worker-no-app-'));
    appRoleApp = await buildApp(makeConfig('app', tmpDirApp));
    await appRoleApp.ready();
  });

  afterAll(async () => {
    await fullApp.close();
    await appRoleApp.close();
    resetPgPool();
    resetPostgresClient();
    rmSync(tmpDirFull, { recursive: true, force: true });
    rmSync(tmpDirApp, { recursive: true, force: true });
  });

  it('full role: /api/worker/status returns 404', async () => {
    const res = await fullApp.inject({
      method: 'GET',
      url: '/api/worker/status',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('app role: /api/worker/status returns 404', async () => {
    const res = await appRoleApp.inject({
      method: 'GET',
      url: '/api/worker/status',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
