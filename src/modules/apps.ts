// ── Apps Module ──────────────────────────────────────────────────────────────
//
// High-level app lifecycle actions. Uses AppSpec as the source of truth and
// orchestrates container creation/start/stop/restart via the apps service.
//
// Routes (all under /api/apps, require auth):
//   POST /:name/deploy   — deploy (create container from spec + start)
//   POST /:name/start    — start a stopped container
//   POST /:name/stop     — stop a running container
//   POST /:name/restart  — restart a running container
//   GET  /:name/logs     — tail container logs

import type { FastifyPluginAsync } from 'fastify';
import {
  deployApp,
  startApp,
  stopApp,
  restartApp,
  getAppLogs,
} from '../services/apps.js';

export const appsModule: FastifyPluginAsync = async (app) => {
  const state = app.stateManager;

  // POST /api/apps/:name/deploy
  // Deploy involves git clone + docker build — can take several minutes
  app.post<{ Params: { name: string } }>('/:name/deploy', async (request, reply) => {
    const { name } = request.params;

    // Extend timeout for long builds (5 min)
    request.raw.setTimeout(300_000);

    const spec = state.getAppSpec(name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${name}' not found` });
      return;
    }

    const result = await deployApp(state, name);
    if (!result.success) {
      reply.code(500).send(result);
      return;
    }
    return result;
  });

  // POST /api/apps/:name/start
  app.post<{ Params: { name: string } }>('/:name/start', async (request, reply) => {
    const { name } = request.params;

    const spec = state.getAppSpec(name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${name}' not found` });
      return;
    }

    const result = await startApp(state, name);
    if (!result.success) {
      reply.code(500).send(result);
      return;
    }
    return result;
  });

  // POST /api/apps/:name/stop
  app.post<{ Params: { name: string } }>('/:name/stop', async (request, reply) => {
    const { name } = request.params;

    const spec = state.getAppSpec(name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${name}' not found` });
      return;
    }

    const result = await stopApp(state, name);
    if (!result.success) {
      reply.code(500).send(result);
      return;
    }
    return result;
  });

  // POST /api/apps/:name/restart
  app.post<{ Params: { name: string } }>('/:name/restart', async (request, reply) => {
    const { name } = request.params;

    const spec = state.getAppSpec(name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${name}' not found` });
      return;
    }

    const result = await restartApp(state, name);
    if (!result.success) {
      reply.code(500).send(result);
      return;
    }
    return result;
  });

  // GET /api/apps/:name/logs
  app.get<{
    Params: { name: string };
    Querystring: { tail?: string };
  }>('/:name/logs', async (request, reply) => {
    const { name } = request.params;
    const tail = Math.min(parseInt(request.query.tail ?? '100', 10) || 100, 1000);

    const result = await getAppLogs(name, tail);
    if (!result.found) {
      reply.code(404).send({ error: `No container found for app '${name}'` });
      return;
    }
    return { appName: name, logs: result.logs };
  });
};
