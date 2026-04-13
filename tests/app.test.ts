// ── App & Health Tests ──────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AgentConfig } from '../src/config.js';

// ── Test config ────────────────────────────────────────────────────────────

const testConfig: AgentConfig = {
  port: 0, // random port for tests
  host: '127.0.0.1',
  authToken: 'test-secret-token-1234',
  version: '1.0.0-test',
  statePath: '/tmp/platform-test',
  logLevel: 'error', // quiet during tests
  rateLimitMax: 1000,
};

// ── App lifecycle ──────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig);
  await app.ready();
});

afterAll(async () => {
  await app.close();
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
      headers: { authorization: `Bearer ${testConfig.authToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── Module routes exist ────────────────────────────────────────────────────

describe('Module routes', () => {
  const authHeaders = { authorization: `Bearer ${testConfig.authToken}` };

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

  it('GET /api/docker/containers is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/containers', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/docker/containers is reachable', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docker/containers', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/docker/images is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/images', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/docker/volumes is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/volumes', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/state/appspecs is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state/appspecs', headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('PUT /api/state/appspecs/:name is reachable', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/state/appspecs/my-app',
      headers: authHeaders,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('my-app');
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
