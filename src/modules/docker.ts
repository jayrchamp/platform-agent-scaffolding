// ── Docker Module ───────────────────────────────────────────────────────────
//
// Manages containers via Docker Engine API (Unix socket, via Dockerode).
// No direct docker CLI calls.
//
// Routes (all under /api/docker, require auth):
//   GET  /containers            — list all containers
//   POST /containers            — create and start a container
//   POST /containers/:id/action — start/stop/restart/remove
//   GET  /containers/:id/logs   — tail container logs
//   GET  /images                — list images
//   GET  /volumes               — list volumes
//   GET  /ping                  — Docker connectivity check

import type { FastifyPluginAsync } from 'fastify';
import {
  listContainers,
  createContainer,
  containerAction,
  getContainerLogs,
  listImages,
  listVolumes,
  pingDocker,
  type CreateContainerOptions,
} from '../services/docker.js';

export const dockerModule: FastifyPluginAsync = async (app) => {
  // GET /api/docker/containers
  app.get<{ Querystring: { all?: string } }>('/containers', async (request) => {
    const showAll = request.query.all !== 'false'; // default: show all (including stopped)
    return { containers: await listContainers(showAll) };
  });

  // POST /api/docker/containers
  app.post<{ Body: CreateContainerOptions }>('/containers', async (request, reply) => {
    const options = request.body;

    if (!options?.name || !options?.image) {
      reply.code(400).send({ error: 'name and image are required' });
      return;
    }

    try {
      const container = await createContainer(options);
      reply.code(201).send(container);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create container';
      reply.code(500).send({ error: message });
    }
  });

  // POST /api/docker/containers/:id/action
  app.post<{
    Params: { id: string };
    Body: { action: 'start' | 'stop' | 'restart' | 'remove' };
  }>('/containers/:id/action', async (request, reply) => {
    const { id } = request.params;
    const { action } = request.body ?? {};

    const validActions = ['start', 'stop', 'restart', 'remove'] as const;
    if (!action || !validActions.includes(action)) {
      reply.code(400).send({ error: `action must be one of: ${validActions.join(', ')}` });
      return;
    }

    const result = await containerAction(id, action);
    if (!result.success) {
      reply.code(500).send(result);
      return;
    }
    return result;
  });

  // GET /api/docker/containers/:id/logs
  app.get<{
    Params: { id: string };
    Querystring: { tail?: string };
  }>('/containers/:id/logs', async (request) => {
    const { id } = request.params;
    const tail = Math.min(parseInt(request.query.tail ?? '100', 10) || 100, 1000);
    const logs = await getContainerLogs(id, tail);
    return { containerId: id, logs };
  });

  // GET /api/docker/images
  app.get('/images', async () => {
    return { images: await listImages() };
  });

  // GET /api/docker/volumes
  app.get('/volumes', async () => {
    return { volumes: await listVolumes() };
  });

  // GET /api/docker/ping
  app.get('/ping', async () => {
    const ok = await pingDocker();
    return { docker: ok ? 'connected' : 'unreachable' };
  });
};
