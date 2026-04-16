// ── Worker Module ────────────────────────────────────────────────────────────
//
// Placeholder module for the worker role. Provides status/diagnostic endpoints.
// Loaded only when role === 'worker'.
//
// Routes (under /api/worker, require auth):
//   GET /status       — worker status with DB connectivity and app server info
//   GET /jobs         — placeholder for future job queue
//   GET /connectivity — full diagnostic: DB + app servers

import type { FastifyPluginAsync } from 'fastify';
import { getPostgresClient } from '../services/postgres-client.js';
import { HttpAppServerClient } from '../services/app-server-client.js';

export const workerModule: FastifyPluginAsync = async (app) => {
  const config = app.config;
  const appServerClient = new HttpAppServerClient();

  // GET /api/worker/status
  app.get('/status', async () => {
    const database = await checkDbConnectivity();
    const appServers = await checkAppServers();

    return {
      role: 'worker' as const,
      ready: database.connected,
      database,
      appServers,
      jobTypes: [] as string[],
    };
  });

  // GET /api/worker/jobs — placeholder
  app.get('/jobs', async () => {
    return {
      jobs: [] as unknown[],
      total: 0,
      message:
        'Job execution not yet implemented. This is a foundation endpoint.',
    };
  });

  // GET /api/worker/connectivity — full diagnostic
  app.get('/connectivity', async () => {
    const database = await checkDbConnectivity();
    const appServers = await checkAppServers();

    return {
      database,
      appServers,
      summary: {
        dbReachable: database.connected,
        appServersReachable: appServers.filter((s) => s.reachable).length,
        appServersTotal: appServers.length,
      },
    };
  });

  async function checkDbConnectivity(): Promise<{
    connected: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    try {
      const pgClient = getPostgresClient();
      const start = Date.now();
      await pgClient.isAvailable();
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function checkAppServers(): Promise<
    Array<{
      name: string;
      host: string;
      reachable: boolean;
      version?: string;
      error?: string;
    }>
  > {
    const results = [];
    for (const server of config.appServers ?? []) {
      const result = await appServerClient.ping(server, config.authToken);
      results.push({
        name: server.name,
        host: server.host,
        ...result,
      });
    }
    return results;
  }
};
