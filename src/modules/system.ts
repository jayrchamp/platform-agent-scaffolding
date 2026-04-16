// ── System Module ───────────────────────────────────────────────────────────
//
// Exposes VPS system metrics: CPU, RAM, disk, network, processes, uptime.
// Reads from /proc (Linux). Data is cached via metrics-cache for performance.
//
// Routes (all under /api/system, require auth):
//   GET /metrics             — CPU %, RAM %, disk %, network I/O
//   GET /processes           — top processes sorted by CPU usage
//   GET /uptime              — uptime + load average + boot time
//   GET /check-connectivity  — TCP connectivity check to a remote host:port

import type { FastifyPluginAsync } from 'fastify';
import {
  getCachedMetrics,
  getCachedProcesses,
  getCachedUptime,
  startMetricsRefresh,
  stopMetricsRefresh,
} from '../utils/metrics-cache.js';
import {
  checkTcpConnectivity,
  classifyConnectivityError,
} from '../services/connectivity.js';

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
  app.get<{ Querystring: { limit?: string } }>(
    '/processes',
    async (request) => {
      const limit = Math.min(
        parseInt(request.query.limit ?? '10', 10) || 10,
        50
      );
      return { processes: getCachedProcesses(limit) };
    }
  );

  // GET /api/system/uptime
  app.get('/uptime', async () => {
    return getCachedUptime();
  });

  // GET /api/system/check-connectivity?host=<ip>&port=<port>
  app.get<{ Querystring: { host?: string; port?: string } }>(
    '/check-connectivity',
    async (request, reply) => {
      const { host, port } = request.query;

      if (!host || !port) {
        return reply
          .status(400)
          .send({ error: 'host and port query parameters are required' });
      }

      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return reply
          .status(400)
          .send({ error: 'port must be a valid number (1-65535)' });
      }

      const startTime = Date.now();

      try {
        await checkTcpConnectivity(host, portNum, 5000);
        const latencyMs = Date.now() - startTime;
        return { reachable: true, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return {
          reachable: false,
          latencyMs,
          error: classifyConnectivityError(err),
        };
      }
    }
  );
};
