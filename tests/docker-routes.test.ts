// ── Docker Routes Tests ─────────────────────────────────────────────────────
//
// Tests the Docker module HTTP routes with mocked Dockerode.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Docker from 'dockerode';
import { buildApp } from '../src/app.js';
import { setDockerClient, resetDockerClient } from '../src/services/docker.js';
import type { AgentConfig } from '../src/config.js';

const TOKEN = 'test-docker-routes-token';
const authHeaders = { authorization: `Bearer ${TOKEN}` };

const testConfig: AgentConfig = {
  port: 0,
  host: '127.0.0.1',
  authToken: TOKEN,
  version: '1.0.0-test',
  statePath: '/tmp/platform-test',
  logLevel: 'error',
  rateLimitMax: 1000,
};

// ── Mock ───────────────────────────────────────────────────────────────────

function setupMock(): void {
  const mock = {
    listContainers: vi.fn().mockResolvedValue([
      {
        Id: 'aabb112233445566',
        Names: ['/test-container'],
        Image: 'nginx:latest',
        State: 'running',
        Status: 'Up 1 hour',
        Created: Math.floor(Date.now() / 1000),
        Ports: [],
        Labels: {},
        NetworkSettings: { Networks: { bridge: {} } },
      },
    ]),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    ping: vi.fn().mockResolvedValue('OK'),
  } as unknown as Docker;

  setDockerClient(mock);
}

// ── App lifecycle ──────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  setupMock();
  app = await buildApp(testConfig);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetDockerClient();
});

// ── Route tests ────────────────────────────────────────────────────────────

describe('GET /api/docker/containers', () => {
  it('returns container list with auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docker/containers',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.containers).toHaveLength(1);
    expect(body.containers[0].name).toBe('test-container');
  });

  it('rejects without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docker/containers' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/docker/containers', () => {
  it('rejects without name and image', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/docker/containers',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name and image/);
  });
});

describe('GET /api/docker/images', () => {
  it('returns image list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docker/images',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().images).toBeDefined();
  });
});

describe('GET /api/docker/volumes', () => {
  it('returns volume list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docker/volumes',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().volumes).toBeDefined();
  });
});

describe('GET /api/docker/ping', () => {
  it('returns docker connected status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docker/ping',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().docker).toBe('connected');
  });
});
