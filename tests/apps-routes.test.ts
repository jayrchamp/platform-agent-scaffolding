// ── Apps Module Routes Tests ─────────────────────────────────────────────────
//
// Tests for the apps module routes using vi.mock to intercept service calls.
// Since the apps module imports service functions at module scope, we must use
// vi.mock (hoisted before imports) rather than vi.spyOn.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ── Mock service modules BEFORE they are imported by the app ────────────────
// vi.hoisted() runs before vi.mock factories, so these are available

const {
  mockDeployApp, mockStartApp, mockStopApp, mockRestartApp,
  mockGetAppLogs, mockFindAppContainer, mockContainerAction,
  mockGetBuildLogPath, mockExecFile,
} = vi.hoisted(() => ({
  mockDeployApp: vi.fn(),
  mockStartApp: vi.fn(),
  mockStopApp: vi.fn(),
  mockRestartApp: vi.fn(),
  mockGetAppLogs: vi.fn(),
  mockFindAppContainer: vi.fn(),
  mockContainerAction: vi.fn(),
  mockGetBuildLogPath: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock('../src/services/apps.js', () => ({
  deployApp: mockDeployApp,
  startApp: mockStartApp,
  stopApp: mockStopApp,
  restartApp: mockRestartApp,
  getAppLogs: mockGetAppLogs,
  findAppContainer: mockFindAppContainer,
}));

vi.mock('../src/services/docker.js', () => ({
  containerAction: mockContainerAction,
  listContainers: vi.fn().mockResolvedValue([]),
  createContainer: vi.fn(),
  getContainerLogs: vi.fn(),
}));

vi.mock('../src/services/build.js', () => ({
  getBuildLogPath: mockGetBuildLogPath,
  setBuildsBase: vi.fn(),
  buildFromRepo: vi.fn(),
  clearBuildLog: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: (...args: unknown[]) => {
      // If the last arg is a callback function, call it
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        mockExecFile(...args);
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return mockExecFile(...args);
    },
  };
});

// ── Now import the app builder (it will use our mocked modules) ─────────────

import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import type { AgentConfig } from '../src/config.js';

// ── Setup ──────────────────────────────────────────────────────────────────

const AUTH_TOKEN = 'test-secret-token-1234';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-apps-test-'));
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

// ── Helper: Create AppSpec in state manager ────────────────────────────────

function createTestAppSpec(appName: string, overrides: Record<string, unknown> = {}) {
  const spec = {
    name: appName,
    image: `${appName}:latest`,
    port: 3000,
    hostPort: 3001,
    env: [],
    domains: [],
    ...overrides,
  };
  app.stateManager.saveAppSpec(spec as any, {
    changedBy: 'test' as any,
    changeDescription: 'Test app spec creation',
  });
  return spec;
}

// ── Auth Tests ─────────────────────────────────────────────────────────────

describe('Apps routes — Authentication', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/test-app/deploy',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/test-app/logs',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts requests with valid token (non-deploy route)', async () => {
    mockGetAppLogs.mockResolvedValue({ found: true, logs: 'ok' });
    createTestAppSpec('auth-test');
    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/auth-test/logs',
      headers: authHeaders,
    });
    expect([200, 404]).toContain(res.statusCode);
  });
});

// ── POST /:name/deploy ─────────────────────────────────────────────────────

describe('POST /api/apps/:name/deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deploys an app successfully', async () => {
    createTestAppSpec('deploy-test');
    mockDeployApp.mockResolvedValue({
      success: true,
      appName: 'deploy-test',
      action: 'deploy',
      state: 'running',
      containerInfo: { id: 'c-123', name: 'app-deploy-test' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/deploy-test/deploy',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().action).toBe('deploy');
    expect(res.json().appName).toBe('deploy-test');
    expect(mockDeployApp).toHaveBeenCalled();
  });

  it('returns 404 when AppSpec not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/nonexistent/deploy',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it('returns 500 on deployment failure', async () => {
    createTestAppSpec('deploy-fail');
    mockDeployApp.mockResolvedValue({
      success: false,
      appName: 'deploy-fail',
      action: 'deploy',
      error: 'Build failed: Git clone timed out',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/deploy-fail/deploy',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/Build failed/);
  });
});

// ── POST /:name/start ──────────────────────────────────────────────────────

describe('POST /api/apps/:name/start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts a stopped app successfully', async () => {
    createTestAppSpec('start-test');
    mockStartApp.mockResolvedValue({
      success: true, appName: 'start-test', action: 'start', state: 'running',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/start-test/start',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().action).toBe('start');
  });

  it('returns 404 when AppSpec not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/nonexistent/start',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 on start failure', async () => {
    createTestAppSpec('start-fail');
    mockStartApp.mockResolvedValue({
      success: false, appName: 'start-fail', action: 'start', error: 'Container is corrupted',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/start-fail/start',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── POST /:name/stop ───────────────────────────────────────────────────────

describe('POST /api/apps/:name/stop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops a running app successfully', async () => {
    createTestAppSpec('stop-test');
    mockStopApp.mockResolvedValue({
      success: true, appName: 'stop-test', action: 'stop', state: 'stopped',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/stop-test/stop',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('stopped');
  });

  it('returns 404 when AppSpec not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/nonexistent/stop',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 on stop failure', async () => {
    createTestAppSpec('stop-fail');
    mockStopApp.mockResolvedValue({
      success: false, appName: 'stop-fail', action: 'stop', error: 'Docker socket unreachable',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/stop-fail/stop',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── POST /:name/restart ────────────────────────────────────────────────────

describe('POST /api/apps/:name/restart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restarts a running app successfully', async () => {
    createTestAppSpec('restart-test');
    mockRestartApp.mockResolvedValue({
      success: true, appName: 'restart-test', action: 'restart', state: 'running',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/restart-test/restart',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('restart');
  });

  it('returns 404 when AppSpec not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/nonexistent/restart',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 on restart failure', async () => {
    createTestAppSpec('restart-fail');
    mockRestartApp.mockResolvedValue({
      success: false, appName: 'restart-fail', action: 'restart', error: 'Permission denied',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/apps/restart-fail/restart',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── GET /:name/logs ────────────────────────────────────────────────────────

describe('GET /api/apps/:name/logs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns container logs successfully', async () => {
    createTestAppSpec('logs-test');
    mockGetAppLogs.mockResolvedValue({
      found: true,
      logs: 'App started\n[INFO] Listening on :3000\n',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/logs-test/logs',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().appName).toBe('logs-test');
    expect(res.json().logs).toContain('App started');
  });

  it('returns 404 when container not found', async () => {
    createTestAppSpec('logs-notfound');
    mockGetAppLogs.mockResolvedValue({ found: false, logs: '' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/logs-notfound/logs',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(404);
  });

  it('passes default tail=100', async () => {
    createTestAppSpec('logs-default-tail');
    mockGetAppLogs.mockResolvedValue({ found: true, logs: 'ok' });

    await app.inject({
      method: 'GET',
      url: '/api/apps/logs-default-tail/logs',
      headers: authHeaders,
    });

    expect(mockGetAppLogs).toHaveBeenCalledWith('logs-default-tail', 100);
  });

  it('passes custom tail query param', async () => {
    createTestAppSpec('logs-custom-tail');
    mockGetAppLogs.mockResolvedValue({ found: true, logs: 'ok' });

    await app.inject({
      method: 'GET',
      url: '/api/apps/logs-custom-tail/logs?tail=50',
      headers: authHeaders,
    });

    expect(mockGetAppLogs).toHaveBeenCalledWith('logs-custom-tail', 50);
  });

  it('caps tail at 1000', async () => {
    createTestAppSpec('logs-cap-tail');
    mockGetAppLogs.mockResolvedValue({ found: true, logs: 'ok' });

    await app.inject({
      method: 'GET',
      url: '/api/apps/logs-cap-tail/logs?tail=5000',
      headers: authHeaders,
    });

    expect(mockGetAppLogs).toHaveBeenCalledWith('logs-cap-tail', 1000);
  });
});

// ── GET /:name/build-log ───────────────────────────────────────────────────

describe('GET /api/apps/:name/build-log', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns build log with size when file exists', async () => {
    createTestAppSpec('build-log-test');
    const buildLogDir = join(tmpDir, 'builds', 'build-log-test');
    mkdirSync(buildLogDir, { recursive: true });
    const logPath = join(buildLogDir, 'build.log');
    const logContent = 'Building app...\nStep 1/10\nDone\n';
    writeFileSync(logPath, logContent);

    mockGetBuildLogPath.mockReturnValue(logPath);

    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/build-log-test/build-log',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().log).toBe(logContent);
    expect(res.json().size).toBe(logContent.length);
  });

  it('returns empty log when file does not exist', async () => {
    createTestAppSpec('build-log-missing');
    mockGetBuildLogPath.mockReturnValue('/nonexistent/build.log');

    const res = await app.inject({
      method: 'GET',
      url: '/api/apps/build-log-missing/build-log',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().log).toBe('');
    expect(res.json().size).toBe(0);
  });
});

// ── DELETE /:name ──────────────────────────────────────────────────────────

describe('DELETE /api/apps/:name', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes app successfully without postgres', async () => {
    createTestAppSpec('del-nopg', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue({
      id: 'c-del', name: 'app-del-nopg', state: 'running', status: 'Up', image: 'x', ports: [], mounts: [],
    });
    mockContainerAction.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-nopg',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().appName).toBe('del-nopg');
    expect(res.json().warnings).toHaveLength(0);
    expect(mockContainerAction).toHaveBeenCalledWith('c-del', 'remove', { removeVolumes: true });
  });

  it('returns 404 when AppSpec not found', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/apps/nonexistent',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it('continues even if container removal fails', async () => {
    createTestAppSpec('del-fail-container', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue({
      id: 'c-fail', name: 'app-del-fail', state: 'running', status: 'Up', image: 'x', ports: [], mounts: [],
    });
    mockContainerAction.mockRejectedValue(new Error('Docker socket unreachable'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-fail-container',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().warnings.length).toBeGreaterThan(0);
    expect(res.json().warnings[0]).toMatch(/Container removal failed/);
  });

  it('succeeds even when no container exists', async () => {
    createTestAppSpec('del-no-container', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-no-container',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('removes AppSpec from state', async () => {
    createTestAppSpec('del-check-state', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue(undefined);

    await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-check-state',
      headers: authHeaders,
    });

    expect(app.stateManager.getAppSpec('del-check-state')).toBeUndefined();
  });

  it('logs operation', async () => {
    createTestAppSpec('del-log-op', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue(undefined);

    await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-log-op',
      headers: authHeaders,
    });

    // Read the operations log file (JSON Lines format)
    const opsLogPath = join(tmpDir, 'operations.log');
    const { readFileSync } = await import('node:fs');
    const logContent = readFileSync(opsLogPath, 'utf-8').trim();
    const ops = logContent.split('\n').map((line: string) => JSON.parse(line));
    const deleteOp = ops.find((op: any) => op.type === 'delete_app' && op.target === 'del-log-op');
    expect(deleteOp).toBeDefined();
    expect(deleteOp?.status).toBe('completed');
  });

  it('stops health monitoring', async () => {
    createTestAppSpec('del-monitor', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(app.healthMonitor, 'stopMonitoring');

    await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-monitor',
      headers: authHeaders,
    });

    expect(stopSpy).toHaveBeenCalledWith('del-monitor');
  });

  it('removes runtime app state', async () => {
    createTestAppSpec('del-runtime', { postgres: undefined });
    mockFindAppContainer.mockResolvedValue(undefined);
    app.stateManager.transitionAppState('del-runtime', 'running');

    await app.inject({
      method: 'DELETE',
      url: '/api/apps/del-runtime',
      headers: authHeaders,
    });

    expect(app.stateManager.getAppState('del-runtime')).toBeUndefined();
  });
});

// ── Integration: lifecycle ─────────────────────────────────────────────────

describe('Apps routes — Lifecycle integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deploy → stop → start → restart lifecycle', async () => {
    const name = 'lifecycle-app';
    createTestAppSpec(name);

    mockDeployApp.mockResolvedValue({ success: true, appName: name, action: 'deploy', state: 'running' });
    mockStopApp.mockResolvedValue({ success: true, appName: name, action: 'stop', state: 'stopped' });
    mockStartApp.mockResolvedValue({ success: true, appName: name, action: 'start', state: 'running' });
    mockRestartApp.mockResolvedValue({ success: true, appName: name, action: 'restart', state: 'running' });

    let res = await app.inject({ method: 'POST', url: `/api/apps/${name}/deploy`, headers: authHeaders });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'POST', url: `/api/apps/${name}/stop`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('stopped');

    res = await app.inject({ method: 'POST', url: `/api/apps/${name}/start`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('running');

    res = await app.inject({ method: 'POST', url: `/api/apps/${name}/restart`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('restart');
  });
});
