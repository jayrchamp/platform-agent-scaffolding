// ── Metrics Cache ───────────────────────────────────────────────────────────
//
// Caches system metrics with a configurable interval.
// Avoids reading /proc on every request — reads once, serves from memory.
// The cache auto-refreshes in the background.

import {
  readAllMetrics,
  readTopProcesses,
  readUptime,
  type SystemMetrics,
  type ProcessInfo,
  type UptimeInfo,
} from './system-metrics.js';

// ── Cache state ────────────────────────────────────────────────────────────

let cachedMetrics: SystemMetrics | null = null;
let cachedProcesses: ProcessInfo[] | null = null;
let cachedUptime: UptimeInfo | null = null;

let metricsUpdatedAt = 0;
let processesUpdatedAt = 0;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ── TTLs ───────────────────────────────────────────────────────────────────

/** Metrics refresh interval — 5 seconds is enough for a monitoring dashboard */
const METRICS_TTL_MS = 5_000;

/** Processes refresh interval — more expensive (ps aux), refresh less often */
const PROCESSES_TTL_MS = 10_000;

// ── Public API ─────────────────────────────────────────────────────────────

export function getCachedMetrics(): SystemMetrics {
  const now = Date.now();
  if (!cachedMetrics || now - metricsUpdatedAt > METRICS_TTL_MS) {
    cachedMetrics = readAllMetrics();
    metricsUpdatedAt = now;
  }
  return cachedMetrics;
}

export function getCachedProcesses(limit = 10): ProcessInfo[] {
  const now = Date.now();
  if (!cachedProcesses || now - processesUpdatedAt > PROCESSES_TTL_MS) {
    cachedProcesses = readTopProcesses(limit);
    processesUpdatedAt = now;
  }
  return cachedProcesses;
}

export function getCachedUptime(): UptimeInfo {
  // Uptime is cheap to read and always fresh
  cachedUptime = readUptime();
  return cachedUptime;
}

// ── Background refresh ─────────────────────────────────────────────────────

/** Start periodic background refresh so first request after idle is fast */
export function startMetricsRefresh(): void {
  if (refreshTimer) return;

  // Initial read
  cachedMetrics = readAllMetrics();
  metricsUpdatedAt = Date.now();

  refreshTimer = setInterval(() => {
    try {
      cachedMetrics = readAllMetrics();
      metricsUpdatedAt = Date.now();
    } catch {
      // Keep stale cache on error — better than nothing
    }
  }, METRICS_TTL_MS);

  // Don't block process exit
  refreshTimer.unref();
}

/** Stop background refresh (for graceful shutdown) */
export function stopMetricsRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── Reset (for tests) ──────────────────────────────────────────────────────

export function resetCache(): void {
  stopMetricsRefresh();
  cachedMetrics = null;
  cachedProcesses = null;
  cachedUptime = null;
  metricsUpdatedAt = 0;
  processesUpdatedAt = 0;
}
