// ── State Module ────────────────────────────────────────────────────────────
//
// Persists AppSpecs, operations, and versions in /var/lib/platform/.
// Full implementation in Story 5.4.

import type { FastifyPluginAsync } from 'fastify';

export const stateModule: FastifyPluginAsync = async (app) => {
  // GET /api/state/appspecs — list all AppSpecs
  app.get('/appspecs', async () => {
    // TODO: Story 5.4 — read from /var/lib/platform/appspecs.yaml
    return { stub: true, message: 'AppSpecs — not yet implemented (Story 5.4)' };
  });

  // PUT /api/state/appspecs/:name — create or update an AppSpec
  app.put<{ Params: { name: string } }>('/appspecs/:name', async (request) => {
    const { name } = request.params;
    return { stub: true, name, message: 'Save AppSpec — not yet implemented (Story 5.4)' };
  });

  // GET /api/state/operations — list recent operations
  app.get('/operations', async () => {
    return { stub: true, message: 'Operations log — not yet implemented (Story 5.4)' };
  });

  // GET /api/state/version — agent + platform version
  app.get('/version', async () => {
    return {
      agent: app.config.version,
      platform: app.config.version, // TODO: read from /var/lib/platform/agent.yaml
    };
  });
};
