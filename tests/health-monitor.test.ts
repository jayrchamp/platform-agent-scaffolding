// ── Health Monitor Tests ─────────────────────────────────────────────────────
//
// Comprehensive test suite for HealthMonitor service.
// Tests lifecycle, health check flows, state transitions, and edge cases.
// Uses fake timers and HTTP mocking for deterministic testing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { StateManager, AppHealthStatus } from '../src/services/state.js';
import { HealthMonitor } from '../src/services/health-monitor.js';

// ── Mocks & Fixtures ──────────────────────────────────────────────────────────

vi.mock('node:http', () => ({
  default: {
    get: vi.fn(),
  },
  get: vi.fn(),
}));

/**
 * Create a mock StateManager with optional app states and specs.
 */
function createMockStateManager(
  apps?: Array<{ name: string; state: string; health?: AppHealthStatus }>,
) {
  const states = new Map<string, any>();
  const specs = new Map<string, any>();

  (apps ?? []).forEach((app) => {
    states.set(app.name, {
      name: app.name,
      state: app.state,
      updatedAt: new Date().toISOString(),
      health: app.health,
    });
    specs.set(app.name, {
      name: app.name,
      port: 3000,
      health: {
        endpoint: '/health',
        intervalSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 3,
      },
    });
  });

  return {
    getAppSpec: vi.fn((name: string) => specs.get(name)),
    getAppState: vi.fn((name: string) => states.get(name)),
    listAppStates: vi.fn(() => Array.from(states.values())),
    setAppHealth: vi.fn(),
    transitionAppState: vi.fn((name: string, newState: string) => {
      const s = states.get(name);
      if (s) {
        s.state = newState;
        return s;
      }
      return undefined;
    }),
  } as unknown as StateManager;
}

/**
 * Mock HTTP response with given status code.
 */
function mockHttpResponse(statusCode: number) {
  const mockReq = new EventEmitter() as any;
  mockReq.destroy = vi.fn();

  (http.get as any).mockImplementation((opts: any, callback: any) => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = statusCode;
    mockRes.resume = vi.fn();
    process.nextTick(() => callback(mockRes));
    return mockReq;
  });
}

/**
 * Mock HTTP error (e.g., ECONNREFUSED).
 */
function mockHttpError(errorMessage: string) {
  const mockReq = new EventEmitter() as any;
  mockReq.destroy = vi.fn();

  (http.get as any).mockImplementation(() => {
    process.nextTick(() => mockReq.emit('error', new Error(errorMessage)));
    return mockReq;
  });
}

/**
 * Mock HTTP timeout.
 */
function mockHttpTimeout() {
  const mockReq = new EventEmitter() as any;
  mockReq.destroy = vi.fn();

  (http.get as any).mockImplementation(() => {
    process.nextTick(() => mockReq.emit('timeout'));
    return mockReq;
  });
}

// ── Test Setup ──────────────────────────────────────────────────────────────

let setIntervalSpy: any;
let clearIntervalSpy: any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  // Create spies on global setInterval/clearInterval
  setIntervalSpy = vi.spyOn(global, 'setInterval');
  clearIntervalSpy = vi.spyOn(global, 'clearInterval');
});

afterEach(() => {
  vi.useRealTimers();
  setIntervalSpy?.mockRestore();
  clearIntervalSpy?.mockRestore();
});

// ── Constructor Tests ───────────────────────────────────────────────────────

describe('HealthMonitor constructor', () => {
  it('creates instance with stateManager', () => {
    const stateManager = createMockStateManager();
    const monitor = new HealthMonitor(stateManager);

    expect(monitor).toBeDefined();
  });

  it('has empty monitors map initially', () => {
    const stateManager = createMockStateManager();
    const monitor = new HealthMonitor(stateManager);

    // Monitors map is private, but we can verify by calling stop() without errors
    expect(() => monitor.stop()).not.toThrow();
  });
});

// ── start() Tests ───────────────────────────────────────────────────────────

describe('HealthMonitor.start()', () => {
  it('scans running apps and starts monitoring for those with health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
      { name: 'app-2', state: 'running' },
    ]);

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    // Both should be monitored (setInterval called twice)
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    // Verify getAppSpec was called for both apps
    expect(stateManager.getAppSpec).toHaveBeenCalledWith('app-1');
    expect(stateManager.getAppSpec).toHaveBeenCalledWith('app-2');

    monitor.stop();
  });

  it('skips apps without health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
    ]);

    // Make spec return no health config
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'app-1',
      port: 3000,
      health: undefined,
    });

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    // No interval should be created
    expect(stateManager.getAppSpec).toHaveBeenCalledWith('app-1');

    monitor.stop();
  });

  it('skips stopped/error apps', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'stopped' },
      { name: 'app-2', state: 'error' },
      { name: 'app-3', state: 'running' },
    ]);

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    // Only app-3 should be monitored (stopped/error are skipped during start())
    const specCalls = (stateManager.getAppSpec as any).mock.calls.map((c: any[]) => c[0]);
    expect(specCalls).toContain('app-3');
    expect(specCalls).not.toContain('app-1');
    expect(specCalls).not.toContain('app-2');

    monitor.stop();
  });

  it('also scans degraded apps', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'degraded' },
    ]);

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    // Degraded app should be monitored
    expect(stateManager.getAppSpec).toHaveBeenCalledWith('app-1');

    monitor.stop();
  });

  it('is idempotent (calling twice doesn\'t double-register)', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
    ]);

    const monitor = new HealthMonitor(stateManager);

    monitor.start();
    const firstCallCount = (stateManager.getAppSpec as any).mock.calls.length;

    monitor.start(); // Call again
    const secondCallCount = (stateManager.getAppSpec as any).mock.calls.length;

    // Should not scan again (running flag already true)
    expect(secondCallCount).toBe(firstCallCount);

    monitor.stop();
  });
});

// ── stop() Tests ────────────────────────────────────────────────────────────

describe('HealthMonitor.stop()', () => {
  it('clears all intervals', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
      { name: 'app-2', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    // Advance time to ensure intervals are created
    await vi.advanceTimersByTimeAsync(0);

    const clearCallsBefore = (clearIntervalSpy as any).mock.calls.length;

    monitor.stop();

    // clearInterval should have been called for each app
    const clearCallsAfter = (clearIntervalSpy as any).mock.calls.length;
    expect(clearCallsAfter).toBeGreaterThan(clearCallsBefore);
  });

  it('can be called when no monitors exist (no crash)', async () => {
    const stateManager = createMockStateManager();
    const monitor = new HealthMonitor(stateManager);

    expect(() => monitor.stop()).not.toThrow();
  });
});

// ── startMonitoring() Tests ─────────────────────────────────────────────────

describe('HealthMonitor.startMonitoring()', () => {
  it('creates interval timer for the app', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Verify setInterval was called
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('skips if no spec found', async () => {
    const stateManager = createMockStateManager();
    (stateManager.getAppSpec as any).mockReturnValue(undefined);

    const monitor = new HealthMonitor(stateManager);
    const beforeCall = (setIntervalSpy as any).mock.calls.length;
    monitor.startMonitoring('missing-app');

    // setInterval should not be called
    expect((setIntervalSpy as any).mock.calls.length).toBe(beforeCall);

    monitor.stop();
  });

  it('skips if spec has no health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
    ]);
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'app-1',
      port: 3000,
      health: undefined,
    });

    const monitor = new HealthMonitor(stateManager);
    const beforeCall = (setIntervalSpy as any).mock.calls.length;
    monitor.startMonitoring('app-1');

    // setInterval should not be called
    expect((setIntervalSpy as any).mock.calls.length).toBe(beforeCall);

    monitor.stop();
  });

  it('is idempotent (doesn\'t create duplicate timers)', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);

    monitor.startMonitoring('test-app');
    const firstSetIntervalCalls = (setIntervalSpy as any).mock.calls.length;

    monitor.startMonitoring('test-app'); // Call again
    const secondSetIntervalCalls = (setIntervalSpy as any).mock.calls.length;

    // Should not create a second interval
    expect(secondSetIntervalCalls).toBe(firstSetIntervalCalls);

    monitor.stop();
  });

  it('respects custom intervalSeconds from health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'test-app',
      port: 3000,
      health: {
        endpoint: '/health',
        intervalSeconds: 20,
        timeoutSeconds: 5,
        failureThreshold: 3,
      },
    });

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Verify setInterval was called with 20000ms (20 seconds)
    const calls = (setIntervalSpy as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toBe(20000);

    monitor.stop();
  });
});

// ── stopMonitoring() Tests ──────────────────────────────────────────────────

describe('HealthMonitor.stopMonitoring()', () => {
  it('clears interval for the app', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    const beforeCalls = (clearIntervalSpy as any).mock.calls.length;

    monitor.stopMonitoring('test-app');

    // clearInterval should have been called
    expect((clearIntervalSpy as any).mock.calls.length).toBeGreaterThan(beforeCalls);

    monitor.stop();
  });

  it('does nothing if app isn\'t being monitored', async () => {
    const stateManager = createMockStateManager();
    const monitor = new HealthMonitor(stateManager);

    const beforeCalls = (clearIntervalSpy as any).mock.calls.length;

    monitor.stopMonitoring('non-existent');

    // clearInterval should not be called
    expect((clearIntervalSpy as any).mock.calls.length).toBe(beforeCalls);

    monitor.stop();
  });
});

// ── Health Check Flow Tests ─────────────────────────────────────────────────

describe('Health check flow', () => {
  it('healthy response (200) calls setAppHealth with healthy status', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Trigger the interval callback
    await vi.advanceTimersByTimeAsync(10_000);

    // Verify setAppHealth was called with healthy status
    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ status: 'healthy' }),
    );

    monitor.stop();
  });

  it('healthy response (204) is treated as healthy', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(204);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ status: 'healthy' }),
    );

    monitor.stop();
  });

  it('non-2xx response is treated as unhealthy', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(500);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({
        status: 'unhealthy',
        message: 'HTTP check returned non-2xx',
      }),
    );

    monitor.stop();
  });

  it('connection error is treated as failure', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpError('ECONNREFUSED');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({
        status: 'unhealthy',
      }),
    );

    monitor.stop();
  });

  it('timeout is treated as failure', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpTimeout();

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalled();
    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ status: 'unhealthy' }),
    );

    monitor.stop();
  });

  it('healthy response resets failure count', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    // First: unhealthy
    mockHttpError('Network error');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ status: 'unhealthy' }),
    );

    // Second: healthy
    vi.clearAllMocks();
    mockHttpResponse(200);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ status: 'healthy' }),
    );

    monitor.stop();
  });

  it('healthy response recovers app from degraded to running', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'degraded' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    // Should transition from degraded to running
    expect(stateManager.transitionAppState).toHaveBeenCalledWith(
      'test-app',
      'running',
    );

    monitor.stop();
  });

  it('healthy response doesn\'t transition running app', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    // transitionAppState should not be called (app already running)
    expect(stateManager.transitionAppState).not.toHaveBeenCalled();

    monitor.stop();
  });
});

// ── State Transition Tests ──────────────────────────────────────────────────

describe('State transitions', () => {
  it('transitions to degraded after failure threshold', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpError('Network error');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Failure 1
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.transitionAppState).not.toHaveBeenCalled();

    // Failure 2
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.transitionAppState).not.toHaveBeenCalled();

    // Failure 3 (threshold)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.transitionAppState).toHaveBeenCalledWith(
      'test-app',
      'degraded',
    );

    monitor.stop();
  });

  it('doesn\'t repeatedly transition once degraded', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpError('Network error');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Failures 1, 2, 3 -> degraded
    await vi.advanceTimersByTimeAsync(30_000);

    const callCount = (stateManager.transitionAppState as any).mock.calls.length;

    // More failures, but state remains degraded
    mockHttpError('Still broken');
    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(20_000);

    // transitionAppState should not be called again
    expect(stateManager.transitionAppState).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('respects custom failureThreshold from health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'test-app',
      port: 3000,
      health: {
        endpoint: '/health',
        intervalSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 5,
      },
    });

    mockHttpError('Network error');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Failures 1-4 should not transition
    await vi.advanceTimersByTimeAsync(40_000);
    expect(stateManager.transitionAppState).not.toHaveBeenCalled();

    // Failure 5 (custom threshold)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.transitionAppState).toHaveBeenCalledWith(
      'test-app',
      'degraded',
    );

    monitor.stop();
  });
});

// ── Edge Case Tests ─────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('app deleted while monitoring stops monitoring on next check', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // First check succeeds
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.getAppState).toHaveBeenCalled();

    // Simulate app deletion
    (stateManager.getAppSpec as any).mockReturnValue(undefined);

    vi.clearAllMocks();

    // Next check finds no app
    await vi.advanceTimersByTimeAsync(10_000);

    // stopMonitoring is called (indirectly via the interval callback)
    expect(stateManager.getAppSpec).toHaveBeenCalled();

    monitor.stop();
  });

  it('app stopped while monitoring skips check', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // First check succeeds
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateManager.setAppHealth).toHaveBeenCalled();

    // Simulate app stop
    (stateManager.getAppState as any).mockReturnValue({
      name: 'test-app',
      state: 'stopped',
    });

    vi.clearAllMocks();

    // Next check skips because state is not running/degraded
    await vi.advanceTimersByTimeAsync(10_000);

    // setAppHealth should not be called
    expect(stateManager.setAppHealth).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('no spec health config stops monitoring on next check', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // First check succeeds
    await vi.advanceTimersByTimeAsync(10_000);

    // Simulate config removal
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'test-app',
      port: 3000,
      health: undefined,
    });

    vi.clearAllMocks();

    // Next check finds no health config
    await vi.advanceTimersByTimeAsync(10_000);

    // stopMonitoring is called indirectly
    expect(stateManager.getAppSpec).toHaveBeenCalled();

    monitor.stop();
  });

  it('constructs correct container hostname for HTTP request', async () => {
    const stateManager = createMockStateManager([
      { name: 'my-cool-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('my-cool-app');

    await vi.advanceTimersByTimeAsync(10_000);

    // Verify http.get was called with correct hostname
    const calls = (http.get as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const opts = lastCall[0];

    expect(opts.hostname).toBe('app-my-cool-app');
    expect(opts.port).toBe(3000);
    expect(opts.path).toBe('/health');

    monitor.stop();
  });

  it('respects custom timeout from health config', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);
    (stateManager.getAppSpec as any).mockReturnValue({
      name: 'test-app',
      port: 3000,
      health: {
        endpoint: '/health',
        intervalSeconds: 10,
        timeoutSeconds: 15,
        failureThreshold: 3,
      },
    });

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    // Verify http.get was called with correct timeout
    const calls = (http.get as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const opts = lastCall[0];

    expect(opts.timeout).toBe(15000);

    monitor.stop();
  });

  it('includes lastCheckedAt timestamp in health status', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    await vi.advanceTimersByTimeAsync(10_000);

    const calls = (stateManager.setAppHealth as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const healthStatus = lastCall[1];

    expect(healthStatus.lastCheckedAt).toBeDefined();
    expect(typeof healthStatus.lastCheckedAt).toBe('string');
  });
});

// ── Integration-style Tests ─────────────────────────────────────────────────

describe('Integration scenarios', () => {
  it('monitoring multiple apps independently', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
      { name: 'app-2', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.start();

    await vi.advanceTimersByTimeAsync(10_000);

    // Both apps should have been checked
    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ status: 'healthy' }),
    );
    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'app-2',
      expect.objectContaining({ status: 'healthy' }),
    );

    monitor.stop();
  });

  it('starting and stopping individual monitors during lifecycle', async () => {
    const stateManager = createMockStateManager([
      { name: 'app-1', state: 'running' },
      { name: 'app-2', state: 'running' },
    ]);

    mockHttpResponse(200);

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('app-1');

    await vi.advanceTimersByTimeAsync(10_000);

    const call1Count = (stateManager.setAppHealth as any).mock.calls.length;

    // Stop monitoring app-1
    monitor.stopMonitoring('app-1');

    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(10_000);

    // app-1 should not have been checked again
    expect(stateManager.setAppHealth).not.toHaveBeenCalledWith(
      'app-1',
      expect.anything(),
    );

    // Now start monitoring app-2
    monitor.startMonitoring('app-2');

    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(10_000);

    // app-2 should be checked
    expect(stateManager.setAppHealth).toHaveBeenCalledWith(
      'app-2',
      expect.objectContaining({ status: 'healthy' }),
    );

    monitor.stop();
  });

  it('recovery scenario: degraded -> healthy -> running', async () => {
    const stateManager = createMockStateManager([
      { name: 'test-app', state: 'running' },
    ]);

    mockHttpError('Network error');

    const monitor = new HealthMonitor(stateManager);
    monitor.startMonitoring('test-app');

    // Fail 3 times to reach threshold
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stateManager.transitionAppState).toHaveBeenCalledWith(
      'test-app',
      'degraded',
    );

    // Now app recovers
    vi.clearAllMocks();
    (stateManager.getAppState as any).mockReturnValue({
      name: 'test-app',
      state: 'degraded',
    });

    mockHttpResponse(200);

    await vi.advanceTimersByTimeAsync(10_000);

    // Should transition back to running
    expect(stateManager.transitionAppState).toHaveBeenCalledWith(
      'test-app',
      'running',
    );

    monitor.stop();
  });
});
