// ── System Connectivity Route Tests ─────────────────────────────────────────
//
// Tests for GET /api/system/check-connectivity.
// The connectivity service is mocked — we test routing, validation, and response.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ── Mock connectivity service BEFORE importing the app ───────────────────────

const { mockCheckTcp, mockClassifyError } = vi.hoisted(() => ({
  mockCheckTcp: vi.fn(),
  mockClassifyError: vi.fn(),
}));

vi.mock('../src/services/connectivity.js', () => ({
  checkTcpConnectivity: mockCheckTcp,
  classifyConnectivityError: mockClassifyError,
}));

// Mock heavy deps so buildApp doesn't fail
vi.mock('../src/services/postgres.js', () => ({
  initPostgres: vi.fn(),
  setPgPool: vi.fn(),
  resetPgPool: vi.fn(),
  getPgPool: vi.fn(),
}));

vi.mock('../src/services/build.js', () => ({
  setBuildsBase: vi.fn(),
  buildFromRepo: vi.fn(),
  clearBuildLog: vi.fn(),
  getBuildLogPath: vi.fn(),
}));

import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import type { AgentConfig } from '../src/config.js';

// ── Setup ─────────────────────────────────────────────────────────────────────

const AUTH_TOKEN = 'test-connectivity-token';
const HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-connectivity-'));
  setPgPool({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Pool);

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

// ── Validation ────────────────────────────────────────────────────────────────

describe('GET /api/system/check-connectivity — validation', () => {
  it('returns 400 when host is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?port=5432',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/host/i);
  });

  it('returns 400 when port is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.0.0.1',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/port/i);
  });

  it('returns 400 when port is invalid (not a number)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.0.0.1&port=abc',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/port/i);
  });

  it('returns 400 when port is out of range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.0.0.1&port=99999',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.0.0.1&port=5432',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Success ───────────────────────────────────────────────────────────────────

describe('GET /api/system/check-connectivity — success', () => {
  it('returns reachable:true when TCP connection succeeds', async () => {
    mockCheckTcp.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.114.0.5&port=5432',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.error).toBeUndefined();
  });
});

// ── Failure ───────────────────────────────────────────────────────────────────

describe('GET /api/system/check-connectivity — failure', () => {
  it('returns reachable:false with classified error when connection fails', async () => {
    const err = new Error('connect ECONNREFUSED');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    mockCheckTcp.mockRejectedValue(err);
    mockClassifyError.mockReturnValue('connection_refused');

    const res = await app.inject({
      method: 'GET',
      url: '/api/system/check-connectivity?host=10.114.0.5&port=5432',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(body.error).toBe('connection_refused');
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
