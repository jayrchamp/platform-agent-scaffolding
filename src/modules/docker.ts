// ── Docker Module ───────────────────────────────────────────────────────────
//
// Manages containers via Docker Engine API (Unix socket).
// Full implementation in Story 5.3.

import type { FastifyPluginAsync } from 'fastify';

export const dockerModule: FastifyPluginAsync = async (app) => {
  // GET /api/docker/containers — list all containers
  app.get('/containers', async () => {
    // TODO: Story 5.3 — dockerode listContainers via Unix socket
    return { stub: true, message: 'Container list — not yet implemented (Story 5.3)' };
  });

  // POST /api/docker/containers — create a container
  app.post('/containers', async () => {
    return { stub: true, message: 'Create container — not yet implemented (Story 5.3)' };
  });

  // GET /api/docker/images — list images
  app.get('/images', async () => {
    return { stub: true, message: 'Image list — not yet implemented (Story 5.3)' };
  });

  // GET /api/docker/volumes — list volumes
  app.get('/volumes', async () => {
    return { stub: true, message: 'Volume list — not yet implemented (Story 5.3)' };
  });
};
