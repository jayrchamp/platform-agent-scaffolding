// ── Apps Service Tests ──────────────────────────────────────────────────────
//
// Comprehensive test suite for app lifecycle operations: find, deploy, start,
// stop, restart, and log retrieval. Uses Vitest with globals enabled.

import { vi } from 'vitest';
import type {
  findAppContainer,
  deployApp,
  startApp,
  stopApp,
  restartApp,
  getAppLogs,
} from '../src/services/apps.js';
import type { StateManager, AppSpec } from '../src/services/state.js';
import type { HealthMonitor } from '../src/services/health-monitor.js';
import type { ContainerInfo } from '../src/services/docker.js';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../src/services/docker.js', () => ({
  listContainers: vi.fn(),
  createContainer: vi.fn(),
  containerAction: vi.fn(),
  getContainerLogs: vi.fn(),
}));

vi.mock('../src/services/build.js', () => ({
  buildFromRepo: vi.fn(),
}));

// Import mocked functions for use in assertions
import {
  listContainers,
  createContainer,
  containerAction,
  getContainerLogs,
} from '../src/services/docker.js';
import { buildFromRepo } from '../src/services/build.js';
import {
  findAppContainer as importedFindAppContainer,
  deployApp as importedDeployApp,
  startApp as importedStartApp,
  stopApp as importedStopApp,
  restartApp as importedRestartApp,
  getAppLogs as importedGetAppLogs,
} from '../src/services/apps.js';

// Assign imported functions to test-accessible variables
const findAppContainer = importedFindAppContainer;
const deployApp = importedDeployApp;
const startApp = importedStartApp;
const stopApp = importedStopApp;
const restartApp = importedRestartApp;
const getAppLogs = importedGetAppLogs;

// ── Helper: Mock StateManager ────────────────────────────────────────────────

function createMockStateManager(specOverride?: Partial<AppSpec>): StateManager {
  const spec: AppSpec = {
    name: 'test-app',
    buildStrategy: 'dockerfile',
    repo: {
      url: 'https://github.com/test/repo.git',
      ref: 'main',
      isPrivate: false,
    },
    image: 'test-app:latest',
    port: 3000,
    hostPort: 8080,
    desiredState: 'running',
    env: [
      { key: 'NODE_ENV', value: 'production', isSecret: false },
      { key: 'API_KEY', value: 'secret123', isSecret: true },
    ],
    domains: [
      { domain: 'test-app.example.com', type: 'primary' },
      { domain: 'www.test-app.example.com', type: 'alias' },
    ],
    resources: { memoryMb: 512, cpuShares: 1024 },
    health: {
      endpoint: '/health',
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
    },
    postgres: { dbName: 'testdb', user: 'testuser' },
    metadata: { description: 'Test application', tags: ['test', 'demo'] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...specOverride,
  };

  return {
    getAppSpec: vi.fn().mockReturnValue(spec),
    getAppSpecMeta: vi.fn().mockReturnValue({
      name: 'test-app',
      currentVersion: 3,
      totalVersions: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
    checkHostPortConflict: vi.fn().mockReturnValue(null),
    transitionAppState: vi.fn().mockReturnValue({
      name: 'test-app',
      state: 'running',
      updatedAt: new Date().toISOString(),
    }),
    logOperation: vi.fn(),
    saveAppSpec: vi.fn(),
    listAppStates: vi.fn().mockReturnValue([]),
    getAppState: vi.fn(),
    getAppSpecVersion: vi.fn(),
    getAppSpecVersionHistory: vi.fn(),
    diffAppSpecVersions: vi.fn(),
    deleteApp: vi.fn(),
  } as any;
}

// ── Helper: Mock HealthMonitor ──────────────────────────────────────────────

function createMockHealthMonitor(): HealthMonitor {
  return {
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    start: vi.fn(),
  } as any;
}

// ── Helper: Create realistic mock container ────────────────────────────────

function createMockContainer(name: string = 'app-test-app', overrides?: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: 'container-123abc456def',
    name,
    image: 'test-app:v3',
    state: 'running',
    status: 'Up 2 hours',
    createdAt: '2026-04-12T10:00:00Z',
    ports: [
      {
        containerPort: 3000,
        hostPort: 8080,
        hostIp: '0.0.0.0',
        protocol: 'tcp',
      },
    ],
    labels: {
      'platform.app': 'test-app',
      'platform.managed': 'true',
    },
    networkMode: 'platform-net',
    ...overrides,
  };
}

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('Apps Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up default mocks
    (listContainers as any).mockResolvedValue([]);
    (createContainer as any).mockResolvedValue(
      createMockContainer('app-test-app', { ports: [{ containerPort: 3000, hostPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' }] })
    );
    (containerAction as any).mockResolvedValue({ success: true });
    (getContainerLogs as any).mockResolvedValue('Log line 1\nLog line 2\nLog line 3');
    (buildFromRepo as any).mockResolvedValue({
      success: true,
      imageTag: 'app-test-app:v3',
      durationMs: 5000,
    });
  });

  // ── findAppContainer tests ──────────────────────────────────────────────

  describe('findAppContainer', () => {
    it('should find container by app name without slash prefix', async () => {
      const mockContainer = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([mockContainer]);

      const result = await findAppContainer('test-app');

      expect(result).toEqual(mockContainer);
      expect(listContainers).toHaveBeenCalledWith(true);
    });

    it('should find container with slash prefix in name', async () => {
      const mockContainer = createMockContainer('/app-test-app');
      (listContainers as any).mockResolvedValue([mockContainer]);

      const result = await findAppContainer('test-app');

      expect(result).toEqual(mockContainer);
    });

    it('should return undefined when container not found', async () => {
      (listContainers as any).mockResolvedValue([
        createMockContainer('app-other-app', { labels: { 'platform.app': 'other-app' } }),
        createMockContainer('app-different-app', { labels: { 'platform.app': 'different-app' } }),
      ]);

      const result = await findAppContainer('test-app');

      expect(result).toBeUndefined();
    });

    it('should handle empty container list', async () => {
      (listContainers as any).mockResolvedValue([]);

      const result = await findAppContainer('test-app');

      expect(result).toBeUndefined();
    });

    it('should match exact container name among multiple', async () => {
      const containers = [
        createMockContainer('app-test-app-v1', { labels: { 'platform.app': 'test-app-v1' } }),
        createMockContainer('app-test-app'),
        createMockContainer('app-test-app-v2', { labels: { 'platform.app': 'test-app-v2' } }),
      ];
      (listContainers as any).mockResolvedValue(containers);

      const result = await findAppContainer('test-app');

      expect(result?.name).toBe('app-test-app');
    });
  });

  // ── deployApp tests ─────────────────────────────────────────────────────

  describe('deployApp', () => {
    it('should deploy app with dockerfile build strategy (happy path)', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();

      (listContainers as any).mockResolvedValue([]);

      const result = await deployApp(stateManager, 'test-app', healthMonitor);

      expect(result.success).toBe(true);
      expect(result.appName).toBe('test-app');
      expect(result.action).toBe('deploy');
      expect(result.state).toBe('running');
      expect(result.containerInfo).toBeDefined();

      // Verify build was called
      expect(buildFromRepo).toHaveBeenCalledWith(
        'test-app',
        'https://github.com/test/repo.git',
        'main',
        3
      );

      // Verify state transitions
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'deploying');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'running');

      // Verify container was created
      expect(createContainer).toHaveBeenCalled();

      // Verify health monitoring started
      expect(healthMonitor.startMonitoring).toHaveBeenCalledWith('test-app');

      // Verify operation was logged
      expect(stateManager.logOperation).toHaveBeenCalledTimes(2); // start + completion
    });

    it('should return error when spec not found', async () => {
      const stateManager = createMockStateManager();
      (stateManager.getAppSpec as any).mockReturnValue(null);

      const result = await deployApp(stateManager, 'nonexistent-app');

      expect(result.success).toBe(false);
      expect(result.error).toBe('AppSpec not found');
      expect(result.appName).toBe('nonexistent-app');
      expect(buildFromRepo).not.toHaveBeenCalled();
    });

    it('should transition to error state when build fails', async () => {
      const stateManager = createMockStateManager();
      (buildFromRepo as any).mockResolvedValue({
        success: false,
        error: 'Docker build failed: ENOENT',
      });

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Build failed');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith(
        'test-app',
        'error',
        expect.any(String)
      );
    });

    it('should transition to error state when port conflict detected', async () => {
      const stateManager = createMockStateManager();
      (stateManager.checkHostPortConflict as any).mockReturnValue('other-app');

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Port 8080 is already assigned to app');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith(
        'test-app',
        'error',
        expect.any(String)
      );
    });

    it('should deploy with image strategy (no build)', async () => {
      const stateManager = createMockStateManager({
        buildStrategy: 'image',
        image: 'my-registry.com/test-app:latest',
      });

      (listContainers as any).mockResolvedValue([]);

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(buildFromRepo).not.toHaveBeenCalled();
      expect(createContainer).toHaveBeenCalled();
    });

    it('should auto-assign port when hostPort is null', async () => {
      const stateManager = createMockStateManager({ hostPort: undefined });
      const assignedPort = 32768;
      (createContainer as any).mockResolvedValue(
        createMockContainer('app-test-app', {
          ports: [{ containerPort: 3000, hostPort: assignedPort, hostIp: '0.0.0.0', protocol: 'tcp' }],
        })
      );

      await deployApp(stateManager, 'test-app');

      expect(stateManager.saveAppSpec).toHaveBeenCalledWith(
        expect.objectContaining({ hostPort: assignedPort }),
        expect.objectContaining({
          changedBy: 'system',
          changeDescription: expect.stringContaining('Auto-assigned public port'),
        })
      );
    });

    it('should remove existing container before creating new one', async () => {
      const stateManager = createMockStateManager();
      const existingContainer = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([existingContainer]);

      await deployApp(stateManager, 'test-app');

      expect(containerAction).toHaveBeenCalledWith(existingContainer.id, 'remove');
      expect(createContainer).toHaveBeenCalled();
    });

    it('should throw error when no repo URL configured', async () => {
      const stateManager = createMockStateManager({ repo: undefined });

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no repo URL configured');
    });

    it('should start health monitoring when monitor provided', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();

      await deployApp(stateManager, 'test-app', healthMonitor);

      expect(healthMonitor.startMonitoring).toHaveBeenCalledWith('test-app');
    });

    it('should not start health monitoring when monitor not provided', async () => {
      const stateManager = createMockStateManager();

      await deployApp(stateManager, 'test-app');

      // No error should occur, function should handle undefined gracefully
      expect(createContainer).toHaveBeenCalled();
    });

    it('should log operation with build details', async () => {
      const stateManager = createMockStateManager();

      await deployApp(stateManager, 'test-app');

      const lastCall = (stateManager.logOperation as any).mock.calls[1];
      expect(lastCall[0]).toMatchObject({
        type: 'deploy_app',
        target: 'test-app',
        status: 'completed',
        result: expect.stringContaining('Container'),
      });
    });

    it('should use repo ref from spec', async () => {
      const stateManager = createMockStateManager({
        repo: {
          url: 'https://github.com/test/repo.git',
          ref: 'develop',
          isPrivate: false,
        },
      });

      await deployApp(stateManager, 'test-app');

      expect(buildFromRepo).toHaveBeenCalledWith(
        'test-app',
        'https://github.com/test/repo.git',
        'develop',
        expect.any(Number)
      );
    });

    it('should default to main ref when ref is undefined', async () => {
      const stateManager = createMockStateManager({
        repo: { url: 'https://github.com/test/repo.git', ref: undefined as any, isPrivate: false },
      });

      await deployApp(stateManager, 'test-app');

      expect(buildFromRepo).toHaveBeenCalledWith(
        'test-app',
        'https://github.com/test/repo.git',
        'main',
        expect.any(Number)
      );
    });

    it('should handle build errors from subprocess', async () => {
      const stateManager = createMockStateManager();
      (buildFromRepo as any).mockResolvedValue({
        success: false,
        error: 'Failed to clone repository: authentication failed',
      });

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Build failed');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith(
        'test-app',
        'error',
        expect.stringContaining('Build failed')
      );
    });
  });

  // ── startApp tests ──────────────────────────────────────────────────────

  describe('startApp', () => {
    it('should start stopped container', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const stoppedContainer = createMockContainer('app-test-app', { state: 'exited' });
      (listContainers as any).mockResolvedValue([stoppedContainer]);

      const result = await startApp(stateManager, 'test-app', healthMonitor);

      expect(result.success).toBe(true);
      expect(result.appName).toBe('test-app');
      expect(result.action).toBe('start');
      expect(result.state).toBe('running');

      expect(containerAction).toHaveBeenCalledWith(stoppedContainer.id, 'start');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'deploying');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'running');
      expect(healthMonitor.startMonitoring).toHaveBeenCalledWith('test-app');
    });

    it('should delegate to deployApp when no container exists', async () => {
      const stateManager = createMockStateManager();
      (listContainers as any).mockResolvedValue([]);

      const result = await startApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(buildFromRepo).toHaveBeenCalled();
      expect(createContainer).toHaveBeenCalled();
    });

    it('should transition to error state when start fails', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (containerAction as any).mockRejectedValue(new Error('Docker daemon not responding'));

      const result = await startApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Docker daemon not responding');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith(
        'test-app',
        'error',
        expect.any(String)
      );
    });

    it('should log successful start operation', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await startApp(stateManager, 'test-app');

      expect(stateManager.logOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start_app',
          target: 'test-app',
          status: 'completed',
        })
      );
    });

    it('should start health monitoring', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await startApp(stateManager, 'test-app', healthMonitor);

      expect(healthMonitor.startMonitoring).toHaveBeenCalledWith('test-app');
    });
  });

  // ── stopApp tests ───────────────────────────────────────────────────────

  describe('stopApp', () => {
    it('should stop running container', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app', { state: 'running' });
      (listContainers as any).mockResolvedValue([container]);

      const result = await stopApp(stateManager, 'test-app', healthMonitor);

      expect(result.success).toBe(true);
      expect(result.appName).toBe('test-app');
      expect(result.action).toBe('stop');
      expect(result.state).toBe('stopped');

      expect(healthMonitor.stopMonitoring).toHaveBeenCalledWith('test-app');
      expect(containerAction).toHaveBeenCalledWith(container.id, 'stop');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'stopped');
    });

    it('should succeed even when no container exists', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      (listContainers as any).mockResolvedValue([]);

      const result = await stopApp(stateManager, 'test-app', healthMonitor);

      expect(result.success).toBe(true);
      expect(result.state).toBe('stopped');
      expect(healthMonitor.stopMonitoring).toHaveBeenCalledWith('test-app');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'stopped');
    });

    it('should stop health monitoring', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await stopApp(stateManager, 'test-app', healthMonitor);

      expect(healthMonitor.stopMonitoring).toHaveBeenCalledWith('test-app');
    });

    it('should handle container action errors gracefully', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (containerAction as any).mockRejectedValue(new Error('Container is not running'));

      const result = await stopApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Container is not running');
    });

    it('should log operation', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await stopApp(stateManager, 'test-app');

      expect(stateManager.logOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop_app',
          target: 'test-app',
          status: 'completed',
        })
      );
    });

    it('should handle missing monitor gracefully', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      const result = await stopApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(containerAction).toHaveBeenCalled();
    });
  });

  // ── restartApp tests ────────────────────────────────────────────────────

  describe('restartApp', () => {
    it('should restart running container', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app', { state: 'running' });
      (listContainers as any).mockResolvedValue([container]);

      const result = await restartApp(stateManager, 'test-app', healthMonitor);

      expect(result.success).toBe(true);
      expect(result.appName).toBe('test-app');
      expect(result.action).toBe('restart');
      expect(result.state).toBe('running');

      expect(containerAction).toHaveBeenCalledWith(container.id, 'restart');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'updating');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith('test-app', 'running');
    });

    it('should restart health monitoring (stop then start)', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await restartApp(stateManager, 'test-app', healthMonitor);

      expect(healthMonitor.stopMonitoring).toHaveBeenCalledWith('test-app');
      expect(healthMonitor.startMonitoring).toHaveBeenCalledWith('test-app');
    });

    it('should delegate to deployApp when no container exists', async () => {
      const stateManager = createMockStateManager();
      (listContainers as any).mockResolvedValue([]);

      const result = await restartApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(buildFromRepo).toHaveBeenCalled();
      expect(createContainer).toHaveBeenCalled();
    });

    it('should transition to error state when restart fails', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (containerAction as any).mockRejectedValue(new Error('Container restart timeout'));

      const result = await restartApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Container restart timeout');
      expect(stateManager.transitionAppState).toHaveBeenCalledWith(
        'test-app',
        'error',
        expect.any(String)
      );
    });

    it('should log successful restart operation', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await restartApp(stateManager, 'test-app');

      expect(stateManager.logOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'restart_app',
          target: 'test-app',
          status: 'completed',
        })
      );
    });
  });

  // ── getAppLogs tests ────────────────────────────────────────────────────

  describe('getAppLogs', () => {
    it('should retrieve logs from container', async () => {
      const mockLogs = 'INFO: Application started\nINFO: Listening on port 3000\nWARN: Low memory';
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (getContainerLogs as any).mockResolvedValue(mockLogs);

      const result = await getAppLogs('test-app');

      expect(result.found).toBe(true);
      expect(result.logs).toBe(mockLogs);
      expect(getContainerLogs).toHaveBeenCalledWith(container.id, 100);
    });

    it('should use custom tail parameter', async () => {
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await getAppLogs('test-app', 50);

      expect(getContainerLogs).toHaveBeenCalledWith(container.id, 50);
    });

    it('should return not found when container does not exist', async () => {
      (listContainers as any).mockResolvedValue([]);

      const result = await getAppLogs('nonexistent-app');

      expect(result.found).toBe(false);
      expect(result.logs).toBe('');
    });

    it('should default tail to 100', async () => {
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      await getAppLogs('test-app');

      expect(getContainerLogs).toHaveBeenCalledWith(container.id, 100);
    });

    it('should handle empty logs', async () => {
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (getContainerLogs as any).mockResolvedValue('');

      const result = await getAppLogs('test-app');

      expect(result.found).toBe(true);
      expect(result.logs).toBe('');
    });

    it('should handle multiline logs', async () => {
      const multilineLogs = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (getContainerLogs as any).mockResolvedValue(multilineLogs);

      const result = await getAppLogs('test-app', 5);

      expect(result.found).toBe(true);
      expect(result.logs).toContain('Line 1');
      expect(result.logs).toContain('Line 5');
    });
  });

  // ── Integration-style tests ─────────────────────────────────────────────

  describe('Full lifecycle workflows', () => {
    it('should execute deploy -> run -> stop -> start cycle', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();

      // Deploy
      (listContainers as any).mockResolvedValue([]);
      let result = await deployApp(stateManager, 'test-app', healthMonitor);
      expect(result.success).toBe(true);

      // Container now exists after deploy
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      // Stop
      result = await stopApp(stateManager, 'test-app', healthMonitor);
      expect(result.success).toBe(true);
      expect(result.state).toBe('stopped');

      // Start
      result = await startApp(stateManager, 'test-app', healthMonitor);
      expect(result.success).toBe(true);
      expect(result.state).toBe('running');
    });

    it('should handle rapid restart cycles', async () => {
      const stateManager = createMockStateManager();
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);

      for (let i = 0; i < 3; i++) {
        const result = await restartApp(stateManager, 'test-app');
        expect(result.success).toBe(true);
      }

      expect(containerAction).toHaveBeenCalledTimes(3);
    });

    it('should handle start -> deploy fallback -> success', async () => {
      const stateManager = createMockStateManager();

      // No container exists initially
      (listContainers as any).mockResolvedValue([]);

      // startApp should delegate to deployApp
      const result = await startApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(buildFromRepo).toHaveBeenCalled();
    });

    it('should handle concurrent health monitor calls', async () => {
      const stateManager = createMockStateManager();
      const healthMonitor = createMockHealthMonitor();
      const container = createMockContainer('app-test-app');

      (listContainers as any).mockResolvedValue([container]);

      // Stop and start in sequence
      await stopApp(stateManager, 'test-app', healthMonitor);
      await startApp(stateManager, 'test-app', healthMonitor);

      expect(healthMonitor.stopMonitoring).toHaveBeenCalled();
      expect(healthMonitor.startMonitoring).toHaveBeenCalled();
    });
  });

  // ── Edge cases and error handling ───────────────────────────────────────

  describe('Edge cases and error handling', () => {
    it('should handle spec with no repo (image-based build)', async () => {
      const stateManager = createMockStateManager({
        buildStrategy: 'image',
        repo: undefined,
        image: 'node:18-alpine',
      });

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(true);
      expect(buildFromRepo).not.toHaveBeenCalled();
    });

    it('should handle dockerfile strategy with missing repo URL', async () => {
      const stateManager = createMockStateManager({
        buildStrategy: 'dockerfile',
        repo: { url: '', ref: 'main', isPrivate: false },
      });

      const result = await deployApp(stateManager, 'test-app');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot build from Dockerfile');
    });

    it('should handle multiple apps with same port but different hostPorts', async () => {
      const appASpec = {
        name: 'app-a',
        port: 3000,
        hostPort: 8080,
      };
      const appBSpec = {
        name: 'app-b',
        port: 3000,
        hostPort: 8081,
      };

      const stateManagerA = createMockStateManager(appASpec);
      const stateManagerB = createMockStateManager(appBSpec);

      (listContainers as any).mockResolvedValue([]);

      const resultA = await deployApp(stateManagerA, 'app-a');
      const resultB = await deployApp(stateManagerB, 'app-b');

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
    });

    it('should preserve non-secret environment variables in container options', async () => {
      const stateManager = createMockStateManager({
        env: [
          { key: 'PUBLIC_VAR', value: 'public-value', isSecret: false },
          { key: 'SECRET_VAR', value: 'secret-value', isSecret: true },
        ],
      });

      (listContainers as any).mockResolvedValue([]);

      await deployApp(stateManager, 'test-app');

      const createCall = (createContainer as any).mock.calls[0][0];
      expect(createCall.env).toContain('PUBLIC_VAR=public-value');
      expect(createCall.env).not.toContain('secret-value');
    });

    it('should handle app names with special characters', async () => {
      const appName = 'my-app-v2';
      const stateManager = createMockStateManager({ name: appName });
      const container = createMockContainer(`app-${appName}`);
      (listContainers as any).mockResolvedValue([container]);

      const result = await findAppContainer(appName);

      expect(result?.name).toBe(`app-${appName}`);
    });

    it('should handle very long logs', async () => {
      const longLogs = 'Log line\n'.repeat(1000);
      const container = createMockContainer('app-test-app');
      (listContainers as any).mockResolvedValue([container]);
      (getContainerLogs as any).mockResolvedValue(longLogs);

      const result = await getAppLogs('test-app');

      expect(result.found).toBe(true);
      expect(result.logs.length).toBeGreaterThan(5000);
    });
  });
});
