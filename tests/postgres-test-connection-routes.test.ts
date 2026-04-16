// ── PostgreSQL Test Connection — Route Tests ────────────────────────────────
//
// Tests for POST /api/postgres/test-connection endpoint (Story 19.4).
// Mocks testPgConnection to avoid real database connections.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ── Mock testPgConnection BEFORE importing the app ───────────────────────────

const { mockTestPgConnection } = vi.hoisted(() => ({
  mockTestPgConnection: vi.fn(),
}));

vi.mock('../src/services/postgres.js', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../src/services/postgres.js')>();
  return {
    ...orig,
    testPgConnection: mockTestPgConnection,
  };
});

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

const AUTH_TOKEN = 'test-pg-conn-token';
const HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-pg-test-'));
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

beforeEach(() => {
  mockTestPgConnection.mockReset();
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('POST /api/postgres/test-connection — validation', () => {
  it('returns 400 when body is missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/test-connection',
      headers: HEADERS,
      payload: { host: '10.0.0.1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required/i);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/test-connection',
      payload: {
        host: '10.0.0.1',
        port: 5432,
        user: 'u',
        password: 'p',
        database: 'd',
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Success ───────────────────────────────────────────────────────────────────

describe('POST /api/postgres/test-connection — success', () => {
  it('returns connected:true with server version', async () => {
    mockTestPgConnection.mockResolvedValue({
      connected: true,
      serverVersion: 'PostgreSQL 16.3',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/test-connection',
      headers: HEADERS,
      payload: {
        host: '10.114.0.5',
        port: 5432,
        user: 'platform',
        password: 'secret',
        database: 'mydb',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.serverVersion).toBe('PostgreSQL 16.3');
  });
});

// ── Failure ───────────────────────────────────────────────────────────────────

describe('POST /api/postgres/test-connection — failure', () => {
  it('returns connected:false with classified error', async () => {
    mockTestPgConnection.mockResolvedValue({
      connected: false,
      error: 'auth_failure',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/postgres/test-connection',
      headers: HEADERS,
      payload: {
        host: '10.114.0.5',
        port: 5432,
        user: 'wrong',
        password: 'wrong',
        database: 'mydb',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toBe('auth_failure');
  });
});
