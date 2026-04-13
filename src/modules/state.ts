// ── State Module ────────────────────────────────────────────────────────────
//
// Persists AppSpecs, operations, and versions in /var/lib/platform/.
//
// Routes (all under /api/state, require auth):
//   GET    /appspecs          — list all AppSpecs
//   GET    /appspecs/:name    — get one AppSpec
//   PUT    /appspecs/:name    — create or update an AppSpec
//   DELETE /appspecs/:name    — delete an AppSpec
//   GET    /operations        — recent operations log
//   GET    /version           — agent + platform version

import type { FastifyPluginAsync } from 'fastify';
import type { AppSpec } from '../services/state.js';

export const stateModule: FastifyPluginAsync = async (app) => {
  const state = app.stateManager;

  // GET /api/state/appspecs
  app.get('/appspecs', async () => {
    return { appspecs: state.listAppSpecs() };
  });

  // GET /api/state/appspecs/:name
  app.get<{ Params: { name: string } }>('/appspecs/:name', async (request, reply) => {
    const spec = state.getAppSpec(request.params.name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${request.params.name}' not found` });
      return;
    }
    return spec;
  });

  // PUT /api/state/appspecs/:name
  app.put<{ Params: { name: string }; Body: Partial<AppSpec> }>('/appspecs/:name', async (request, reply) => {
    const { name } = request.params;
    const body = request.body ?? {};

    const existing = state.getAppSpec(name);
    const image = body.image ?? existing?.image;
    if (!image) {
      reply.code(400).send({ error: 'image is required when creating a new AppSpec' });
      return;
    }

    const spec: AppSpec = {
      ...existing,
      ...body,
      name, // name comes from URL, not body
      image,
      desiredState: body.desiredState ?? existing?.desiredState ?? 'running',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    state.saveAppSpec(spec);
    return spec;
  });

  // DELETE /api/state/appspecs/:name
  app.delete<{ Params: { name: string } }>('/appspecs/:name', async (request, reply) => {
    const deleted = state.deleteAppSpec(request.params.name);
    if (!deleted) {
      reply.code(404).send({ error: `AppSpec '${request.params.name}' not found` });
      return;
    }
    return { deleted: true, name: request.params.name };
  });

  // GET /api/state/operations
  app.get<{ Querystring: { limit?: string } }>('/operations', async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
    return { operations: state.getRecentOperations(limit) };
  });

  // GET /api/state/version
  app.get('/version', async () => {
    const meta = state.getAgentMeta();
    return {
      agent: app.config.version,
      platform: meta?.version ?? app.config.version,
      installedAt: meta?.installedAt,
      lastStartedAt: meta?.lastStartedAt,
    };
  });
};
