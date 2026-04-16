// ── Agent Module ────────────────────────────────────────────────────────────
//
// Agent self-management endpoints: version check, pre-update validation,
// and update trigger.
//
// The actual update (docker pull + recreate) is orchestrated by Electron
// via SSH, because the agent can't restart its own container safely.
// These endpoints provide the information Electron needs to decide and verify.
//
// Routes (under /api/agent, require auth):
//   GET  /version       — current version + uptime
//   POST /prepare-update — validate that an update can proceed safely
//   POST /shutdown       — graceful shutdown (Electron calls this before recreate)

import type { FastifyPluginAsync } from 'fastify';

export const agentModule: FastifyPluginAsync = async (app) => {
  // GET /api/agent/version — detailed version info
  app.get('/version', async () => {
    const meta = app.stateManager.getAgentMeta();

    return {
      version: app.config.version,
      role: app.agentRole,
      uptime: Math.floor(process.uptime()),
      installedAt: meta?.installedAt,
      lastStartedAt: meta?.lastStartedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryUsageMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  });

  // GET /api/agent/capabilities — role and features for this agent
  app.get('/capabilities', async () => {
    const modules = app.loadedModules;
    return {
      role: app.agentRole,
      modules,
      features: {
        postgres: modules.includes('postgres'),
        apps: modules.includes('apps'),
        backup: modules.includes('backup'),
        traefik: modules.includes('traefik'),
      },
    };
  });

  // POST /api/agent/prepare-update — check if it's safe to update
  app.post<{ Body: { targetVersion: string } }>(
    '/prepare-update',
    async (request, reply) => {
      const { targetVersion } = request.body ?? {};

      if (!targetVersion) {
        reply.code(400).send({ error: 'targetVersion is required' });
        return;
      }

      // Check for running operations that would be interrupted
      const runningOps = app.stateManager
        .getRecentOperations(100)
        .filter((op) => op.status === 'running');

      if (runningOps.length > 0) {
        return {
          canUpdate: false,
          reason: `${runningOps.length} operation(s) still running`,
          runningOperations: runningOps.map((op) => ({
            id: op.id,
            type: op.type,
            target: op.target,
            startedAt: op.startedAt,
          })),
        };
      }

      return {
        canUpdate: true,
        currentVersion: app.config.version,
        targetVersion,
        message: 'Safe to update — no running operations',
      };
    }
  );

  // POST /api/agent/shutdown — graceful shutdown request from Electron
  app.post('/shutdown', async (_request, reply) => {
    reply.send({
      status: 'shutting_down',
      message: 'Agent will shut down in 2 seconds',
    });

    // Delay to let the response be sent, then close
    setTimeout(async () => {
      app.log.info('Shutdown requested via API — closing server');
      try {
        await app.close();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    }, 2000);
  });
};
