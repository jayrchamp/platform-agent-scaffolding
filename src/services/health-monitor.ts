// ── Health Monitor ───────────────────────────────────────────────────────────
//
// Background service that polls HTTP health endpoints for running apps.
// Uses Docker container names as hostnames (works inside platform-net).
//
// Architecture:
//   - One timer per app, started when app is running, cleared when stopped/deleted
//   - On unhealthy: increments failure count; transitions to 'degraded' after threshold
//   - On healthy while degraded: transitions back to 'running'
//   - Container name pattern: app-<appName> (e.g. app-test-app)

import http from 'node:http';
import type { StateManager, AppHealthStatus } from './state.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface AppMonitor {
  timer: NodeJS.Timeout;
  consecutiveFailures: number;
}

// ── Health Monitor class ───────────────────────────────────────────────────

export class HealthMonitor {
  private stateManager: StateManager;
  private monitors: Map<string, AppMonitor> = new Map();
  private running = false;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start monitoring all currently running apps */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Boot-time scan: pick up any apps already in running/degraded state
    for (const appState of this.stateManager.listAppStates()) {
      if (appState.state === 'running' || appState.state === 'degraded') {
        const spec = this.stateManager.getAppSpec(appState.name);
        if (spec?.health?.endpoint) {
          this.startMonitoring(appState.name);
        }
      }
    }
  }

  /** Stop all monitors */
  stop(): void {
    this.running = false;
    for (const [name, monitor] of this.monitors) {
      clearInterval(monitor.timer);
      this.monitors.delete(name);
    }
  }

  /** Begin monitoring a specific app (called after deploy/start) */
  startMonitoring(appName: string): void {
    if (this.monitors.has(appName)) return; // already watching

    const spec = this.stateManager.getAppSpec(appName);
    if (!spec?.health?.endpoint) return; // no health check configured

    const intervalMs = (spec.health.intervalSeconds ?? 30) * 1000;

    const timer = setInterval(async () => {
      await this.checkApp(appName);
    }, intervalMs);

    // Don't block process exit
    timer.unref?.();

    this.monitors.set(appName, { timer, consecutiveFailures: 0 });
  }

  /** Stop monitoring a specific app (called on stop/delete) */
  stopMonitoring(appName: string): void {
    const monitor = this.monitors.get(appName);
    if (!monitor) return;

    clearInterval(monitor.timer);
    this.monitors.delete(appName);
  }

  // ── Health check ───────────────────────────────────────────────────────────

  private async checkApp(appName: string): Promise<void> {
    const spec = this.stateManager.getAppSpec(appName);
    const appState = this.stateManager.getAppState(appName);

    if (!spec || !appState) {
      this.stopMonitoring(appName);
      return;
    }

    // Only check running or degraded apps
    if (appState.state !== 'running' && appState.state !== 'degraded') {
      return;
    }

    if (!spec.health?.endpoint || !spec.port) return;

    const containerHostname = `app-${appName}`;
    const url = `http://${containerHostname}:${spec.port}${spec.health.endpoint}`;
    const timeoutMs = (spec.health.timeoutSeconds ?? 5) * 1000;
    const failureThreshold = spec.health.failureThreshold ?? 3;

    const monitor = this.monitors.get(appName);
    if (!monitor) return;

    try {
      const ok = await this.httpGet(url, timeoutMs);

      if (ok) {
        // ── Healthy ──
        monitor.consecutiveFailures = 0;

        const health: AppHealthStatus = {
          status: 'healthy',
          lastCheckedAt: new Date().toISOString(),
        };
        this.stateManager.setAppHealth(appName, health);

        // If app was degraded, bring it back to running
        if (appState.state === 'degraded') {
          this.stateManager.transitionAppState(appName, 'running');
        }
      } else {
        // ── Unhealthy ──
        await this.handleFailure(appName, monitor, failureThreshold, 'HTTP check returned non-2xx');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Health check error';
      await this.handleFailure(appName, monitor, failureThreshold, message);
    }
  }

  private async handleFailure(
    appName: string,
    monitor: AppMonitor,
    threshold: number,
    message: string,
  ): Promise<void> {
    monitor.consecutiveFailures++;

    const health: AppHealthStatus = {
      status: 'unhealthy',
      lastCheckedAt: new Date().toISOString(),
      message,
    };
    this.stateManager.setAppHealth(appName, health);

    // Transition to degraded once threshold exceeded
    if (monitor.consecutiveFailures >= threshold) {
      const appState = this.stateManager.getAppState(appName);
      if (appState?.state === 'running') {
        this.stateManager.transitionAppState(appName, 'degraded');
      }
    }
  }

  // ── HTTP helper ────────────────────────────────────────────────────────────

  private httpGet(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const req = http.get(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : 80,
          path: parsed.pathname + parsed.search,
          timeout: timeoutMs,
        },
        (res) => {
          // 2xx = healthy
          resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
          res.resume(); // drain response to free socket
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => {
        resolve(false);
      });
    });
  }
}
