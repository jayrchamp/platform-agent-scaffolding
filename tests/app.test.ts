// ── App & Health Tests ──────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import type { AgentConfig } from '../src/config.js';

// ── App lifecycle ──────────────────────────────────────────────────────────

const AUTH_TOKEN = 'test-secret-token-1234';

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-app-'));
  // Provide a no-op mock pool so postgres routes don't crash
  setPgPool({ query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool);

  const config: AgentConfig = {
    port: 0,
    host: '127.0.0.1',
    authToken: AUTH_TOKEN,
    version: '1.0.0-test',
    statePath: tmpDir,
    logLevel: 'error',
    rateLimitMax: 1000,
    postgres: { host: 'localhost', port: 5432, user: 'platform', password: '' },
  };

  app = await buildApp(config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetPgPool();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Health endpoint ────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok, version, and uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.0.0-test');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('does NOT require auth', async () => {
    // No Authorization header — should still work
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

// ── Auth middleware ─────────────────────────────────────────────────────────

describe('Auth middleware on /api/*', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Missing Authorization/);
  });

  it('rejects requests with wrong format (no Bearer prefix)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Invalid Authorization format/);
  });

  it('rejects requests with invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Invalid token/);
  });

  it('accepts requests with valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── Module routes exist ────────────────────────────────────────────────────

describe('Module routes', () => {
  const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

  it('GET /api/system/metrics is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/metrics', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/system/processes is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/processes', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/system/uptime is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/uptime', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  // Docker routes hit the real Docker socket — without it, they return 500.
  // These tests just verify the route exists and auth passes (not 401/403).
  it('GET /api/docker/containers is routed (no Docker socket → 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/containers', headers: authHeaders });
    expect([200, 500]).toContain(res.statusCode);
  });

  it('POST /api/docker/containers validates input (400 without body)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docker/containers', headers: authHeaders });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/docker/images is routed (no Docker socket → 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/images', headers: authHeaders });
    expect([200, 500]).toContain(res.statusCode);
  });

  it('GET /api/docker/volumes is routed (no Docker socket → 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/volumes', headers: authHeaders });
    expect([200, 500]).toContain(res.statusCode);
  });

  it('GET /api/state/appspecs is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state/appspecs', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('PUT /api/state/appspecs/:name creates an appspec', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/state/appspecs/my-app',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { image: 'my-app:latest' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('my-app');
    expect(res.json().image).toBe('my-app:latest');
  });

  it('GET /api/state/operations is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state/operations', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/state/version returns agent version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state/version', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBe('1.0.0-test');
  });
});
