// ── Network Module Routes Tests ───────────────────────────────────────────────
//
// Tests for the /api/network/* routes.
// The network service (iptables calls) is mocked — we only test routing,
// auth, validation, and response shaping here.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ── Mock the network service BEFORE importing the app ────────────────────────

const { mockBlockIp, mockUnblockIp, mockCheckIpBlockStatus } = vi.hoisted(() => ({
  mockBlockIp: vi.fn(),
  mockUnblockIp: vi.fn(),
  mockCheckIpBlockStatus: vi.fn(),
}));

vi.mock('../src/services/network.js', () => ({
  blockIp: mockBlockIp,
  unblockIp: mockUnblockIp,
  checkIpBlockStatus: mockCheckIpBlockStatus,
}));

// Also mock pg and other heavy deps so buildApp doesn't fail
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

const AUTH_TOKEN = 'test-network-token';
const HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-network-'));
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

beforeEach(() => {
  mockBlockIp.mockReset();
  mockUnblockIp.mockReset();
  mockCheckIpBlockStatus.mockReset();
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('network routes — auth', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      payload: { originalIp: '142.93.25.10' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: { Authorization: 'Bearer wrong-token' },
      payload: { originalIp: '142.93.25.10' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── POST /api/network/block-original-ip ──────────────────────────────────────

describe('POST /api/network/block-original-ip', () => {
  it('returns 400 when originalIp is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a private IP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: HEADERS,
      payload: { originalIp: '192.168.1.1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and success result for a valid public IP', async () => {
    mockBlockIp.mockResolvedValue({ success: true, message: 'Blocked 142.93.25.10' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: HEADERS,
      payload: { originalIp: '142.93.25.10' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mockBlockIp).toHaveBeenCalledWith('142.93.25.10', undefined);
  });

  it('passes agentPort to the service when provided', async () => {
    mockBlockIp.mockResolvedValue({ success: true, message: 'Blocked' });

    await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: HEADERS,
      payload: { originalIp: '142.93.25.10', agentPort: 3000 },
    });

    expect(mockBlockIp).toHaveBeenCalledWith('142.93.25.10', 3000);
  });

  it('returns 500 when the service throws', async () => {
    mockBlockIp.mockRejectedValue(new Error('iptables: Permission denied'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/network/block-original-ip',
      headers: HEADERS,
      payload: { originalIp: '142.93.25.10' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('Permission denied');
  });
});

// ── POST /api/network/unblock-original-ip ────────────────────────────────────

describe('POST /api/network/unblock-original-ip', () => {
  it('returns 400 when originalIp is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/network/unblock-original-ip',
      headers: HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and success on valid IP', async () => {
    mockUnblockIp.mockResolvedValue({ success: true, message: 'Removed 2 rules' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/network/unblock-original-ip',
      headers: HEADERS,
      payload: { originalIp: '142.93.25.10' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(mockUnblockIp).toHaveBeenCalledWith('142.93.25.10');
  });
});

// ── GET /api/network/original-ip-status ──────────────────────────────────────

describe('GET /api/network/original-ip-status', () => {
  it('returns 400 when ip query param is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/network/original-ip-status',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns "blocked" status', async () => {
    mockCheckIpBlockStatus.mockResolvedValue('blocked');

    const res = await app.inject({
      method: 'GET',
      url: '/api/network/original-ip-status?ip=142.93.25.10',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ip).toBe('142.93.25.10');
    expect(body.status).toBe('blocked');
  });

  it('returns "accessible" status', async () => {
    mockCheckIpBlockStatus.mockResolvedValue('accessible');

    const res = await app.inject({
      method: 'GET',
      url: '/api/network/original-ip-status?ip=142.93.25.10',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('accessible');
  });

  it('returns "unknown" if the service throws', async () => {
    mockCheckIpBlockStatus.mockRejectedValue(new Error('iptables unavailable'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/network/original-ip-status?ip=142.93.25.10',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unknown');
  });
});
