// ── Agent Capabilities Tests ────────────────────────────────────────────────
//
// Tests for GET /api/agent/capabilities and role in /api/agent/version
// across all four agent roles.

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

const AUTH_TOKEN = 'test-capabilities-token';

function makeConfig(role: ServerRole, tmpDir: string): AgentConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    authToken: AUTH_TOKEN,
    version: '2.0.0-test',
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

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

// ── Full role ──────────────────────────────────────────────────────────────

describe('Capabilities — role=full', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'caps-full-'));
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

  it('GET /api/agent/capabilities returns all features true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.role).toBe('full');
    expect(body.modules).toHaveLength(10);
    expect(body.features).toEqual({
      postgres: true,
      apps: true,
      backup: true,
      traefik: true,
    });
  });

  it('GET /api/agent/version includes role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/version',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('full');
  });
});

// ── Database role ──────────────────────────────────────────────────────────

describe('Capabilities — role=database', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'caps-db-'));
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

  it('capabilities show postgres & backup, no apps & traefik', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    const body = res.json();
    expect(body.role).toBe('database');
    expect(body.features).toEqual({
      postgres: true,
      apps: false,
      backup: true,
      traefik: false,
    });
    expect(body.modules).toHaveLength(8);
  });
});

// ── App role ───────────────────────────────────────────────────────────────

describe('Capabilities — role=app', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'caps-app-'));
    app = await buildApp(makeConfig('app', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('capabilities show apps & traefik, no postgres & backup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    const body = res.json();
    expect(body.role).toBe('app');
    expect(body.features).toEqual({
      postgres: false,
      apps: true,
      backup: false,
      traefik: true,
    });
    expect(body.modules).toHaveLength(8);
  });
});

// ── Worker role ────────────────────────────────────────────────────────────

describe('Capabilities — role=worker', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'caps-worker-'));
    app = await buildApp(makeConfig('worker', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('capabilities show no conditional features', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/capabilities',
      headers,
    });
    const body = res.json();
    expect(body.role).toBe('worker');
    expect(body.features).toEqual({
      postgres: false,
      apps: false,
      backup: false,
      traefik: false,
    });
    expect(body.modules).toHaveLength(7);
  });

  it('version endpoint includes role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/version',
      headers,
    });
    expect(res.json().role).toBe('worker');
  });
});

// ── Health endpoint role ───────────────────────────────────────────────────

describe('Health endpoint role field', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'caps-health-'));
    app = await buildApp(makeConfig('database', tmpDir));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetPgPool();
    resetPostgresClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns role without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('database');
  });
});
