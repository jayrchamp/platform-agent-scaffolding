// ── Agent Module Tests ──────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AgentConfig } from '../src/config.js';

const TOKEN = 'test-agent-module-token';
const authHeaders = { authorization: `Bearer ${TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-agent-mod-'));

  const config: AgentConfig = {
    port: 0,
    host: '127.0.0.1',
    authToken: TOKEN,
    version: '1.2.3',
    statePath: tmpDir,
    logLevel: 'error',
    rateLimitMax: 1000,
  };

  app = await buildApp(config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/agent/version', () => {
  it('returns version and system info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/version',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.version).toBe('1.2.3');
    expect(typeof body.uptime).toBe('number');
    expect(body.nodeVersion).toMatch(/^v\d+/);
    expect(typeof body.memoryUsageMb).toBe('number');
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/version' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/agent/prepare-update', () => {
  it('returns canUpdate true when no operations running', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/prepare-update',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { targetVersion: '2.0.0' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.canUpdate).toBe(true);
    expect(body.currentVersion).toBe('1.2.3');
    expect(body.targetVersion).toBe('2.0.0');
  });

  it('rejects without targetVersion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/prepare-update',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks update when operations are running', async () => {
    // Log a running operation
    app.stateManager.logOperation({
      id: 'running-op',
      type: 'deploy',
      target: 'my-app',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/prepare-update',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { targetVersion: '2.0.0' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.canUpdate).toBe(false);
    expect(body.runningOperations).toHaveLength(1);
  });
});

describe('POST /api/agent/shutdown', () => {
  it('returns shutting_down status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/shutdown',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('shutting_down');
  });
});
