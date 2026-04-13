// ── System Module ───────────────────────────────────────────────────────────
//
// Exposes VPS system metrics: CPU, RAM, disk, network, processes, uptime.
// Reads from /proc (Linux). Data is cached via metrics-cache for performance.
//
// Routes (all under /api/system, require auth):
//   GET /metrics    — CPU %, RAM %, disk %, network I/O
//   GET /processes  — top processes sorted by CPU usage
//   GET /uptime     — uptime + load average + boot time

import type { FastifyPluginAsync } from 'fastify';
import {
  getCachedMetrics,
  getCachedProcesses,
  getCachedUptime,
  startMetricsRefresh,
  stopMetricsRefresh,
} from '../utils/metrics-cache.js';

export const systemModule: FastifyPluginAsync = async (app) => {
  // Start background metrics refresh when module loads
  startMetricsRefresh();

  // Stop on server close
  app.addHook('onClose', async () => {
    stopMetricsRefresh();
  });

  // GET /api/system/metrics
  app.get('/metrics', async () => {
    return getCachedMetrics();
  });

  // GET /api/system/processes
  app.get<{ Querystring: { limit?: string } }>('/processes', async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '10', 10) || 10, 50);
    return { processes: getCachedProcesses(limit) };
  });

  // GET /api/system/uptime
  app.get('/uptime', async () => {
    return getCachedUptime();
  });
};
