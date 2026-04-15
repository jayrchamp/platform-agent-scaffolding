// ── Traefik Module Routes Tests ────────────────────────────────────────────────
//
// Tests for the /api/traefik/* routes.
// The traefik service (file I/O) is mocked — we only test routing,
// auth, validation, and response shaping here.

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

// ── Mock the traefik service BEFORE importing the app ─────────────────────────

const {
  mockWriteRouteConfig,
  mockRemoveRouteConfig,
  mockListRouteConfigs,
  mockGetCertificates,
  mockGetCertificateForDomain,
  mockFindAppContainer,
} = vi.hoisted(() => ({
  mockWriteRouteConfig: vi.fn(),
  mockRemoveRouteConfig: vi.fn(),
  mockListRouteConfigs: vi.fn(),
  mockGetCertificates: vi.fn(),
  mockGetCertificateForDomain: vi.fn(),
  mockFindAppContainer: vi.fn(),
}));

vi.mock('../src/services/traefik.js', () => ({
  writeRouteConfig: mockWriteRouteConfig,
  removeRouteConfig: mockRemoveRouteConfig,
  listRouteConfigs: mockListRouteConfigs,
  getCertificates: mockGetCertificates,
  getCertificateForDomain: mockGetCertificateForDomain,
  setTraefikPaths: vi.fn(),
  resetTraefikPaths: vi.fn(),
}));

vi.mock('../src/services/apps.js', () => ({
  findAppContainer: mockFindAppContainer,
  deployApp: vi.fn(),
  startApp: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  getAppLogs: vi.fn(),
}));

// Also mock heavy deps so buildApp doesn't fail
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

const AUTH_TOKEN = 'test-traefik-token';
const HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-traefik-routes-'));
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
  mockWriteRouteConfig.mockReset();
  mockRemoveRouteConfig.mockReset();
  mockListRouteConfigs.mockReset();
  mockGetCertificates.mockReset();
  mockGetCertificateForDomain.mockReset();
  mockFindAppContainer.mockReset();
  // Default: auto-resolve returns a container
  mockFindAppContainer.mockResolvedValue({
    name: 'my-app-web-abc123',
    id: 'abc123',
  });
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('traefik routes — auth', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── GET /api/traefik/routes ────────────────────────────────────────────────────

describe('GET /api/traefik/routes', () => {
  it('returns list of routes', async () => {
    mockListRouteConfigs.mockResolvedValue([
      {
        appName: 'my-app',
        domain: 'app.example.com',
        containerName: 'my-app-web-abc123',
        port: 3000,
        configFile: '/opt/platform/traefik/dynamic/my-app.yml',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].appName).toBe('my-app');
    expect(body.routes[0].domain).toBe('app.example.com');
  });

  it('returns empty array when no routes exist', async () => {
    mockListRouteConfigs.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/routes',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.routes).toEqual([]);
  });
});

// ── PUT /api/traefik/routes/:appName ──────────────────────────────────────────

describe('PUT /api/traefik/routes/:appName', () => {
  it('creates a route with valid body', async () => {
    mockWriteRouteConfig.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        domain: 'app.example.com',
        containerName: 'my-app-web-abc123',
        port: 3000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.appName).toBe('my-app');
    expect(body.domain).toBe('app.example.com');

    expect(mockWriteRouteConfig).toHaveBeenCalledWith(
      'my-app',
      'app.example.com',
      'my-app-web-abc123',
      3000,
      undefined
    );
  });

  it('returns 400 when domain is missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { containerName: 'container', port: 3000 },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('domain');
  });

  it('returns 400 when containerName is missing and container not found', async () => {
    mockFindAppContainer.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { domain: 'app.example.com', port: 3000 },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toContain('No container');
  });

  it('auto-resolves container name when not provided', async () => {
    mockWriteRouteConfig.mockResolvedValue(undefined);
    mockFindAppContainer.mockResolvedValue({
      name: 'my-app-web-def456',
      id: 'def456',
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { domain: 'app.example.com', port: 3000 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockWriteRouteConfig).toHaveBeenCalledWith(
      'my-app',
      'app.example.com',
      'my-app-web-def456',
      3000,
      undefined
    );
  });

  it('returns 400 when port is missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { domain: 'app.example.com', containerName: 'container' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('port');
  });

  it('returns 400 when port is out of range', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        domain: 'app.example.com',
        containerName: 'container',
        port: 99999,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('port');
  });

  it('returns 500 when writeRouteConfig fails', async () => {
    mockWriteRouteConfig.mockRejectedValue(
      new Error('EACCES permission denied')
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/traefik/routes/my-app',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        domain: 'app.example.com',
        containerName: 'container',
        port: 3000,
      },
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload).error).toContain('EACCES');
  });
});

// ── DELETE /api/traefik/routes/:appName ────────────────────────────────────────

describe('DELETE /api/traefik/routes/:appName', () => {
  it('removes a route', async () => {
    mockRemoveRouteConfig.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/traefik/routes/my-app',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.appName).toBe('my-app');

    expect(mockRemoveRouteConfig).toHaveBeenCalledWith('my-app');
  });

  it('returns 500 when removeRouteConfig fails', async () => {
    mockRemoveRouteConfig.mockRejectedValue(new Error('unexpected error'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/traefik/routes/my-app',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── GET /api/traefik/certificates ─────────────────────────────────────────────

describe('GET /api/traefik/certificates', () => {
  it('returns list of certificates', async () => {
    mockGetCertificates.mockResolvedValue([
      {
        domain: 'app.example.com',
        issuer: "Let's Encrypt",
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: '2026-04-01T00:00:00Z',
        daysRemaining: 60,
        isExpiringSoon: false,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/certificates',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.certificates).toHaveLength(1);
    expect(body.certificates[0].domain).toBe('app.example.com');
  });
});

// ── GET /api/traefik/certificates/:domain ─────────────────────────────────────

describe('GET /api/traefik/certificates/:domain', () => {
  it('returns certificate info when found', async () => {
    mockGetCertificateForDomain.mockResolvedValue({
      domain: 'app.example.com',
      issuer: "Let's Encrypt",
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2026-04-01T00:00:00Z',
      daysRemaining: 60,
      isExpiringSoon: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/certificates/app.example.com',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.domain).toBe('app.example.com');
  });

  it('returns 404 when certificate not found', async () => {
    mockGetCertificateForDomain.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/traefik/certificates/missing.example.com',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toContain('missing.example.com');
  });
});
