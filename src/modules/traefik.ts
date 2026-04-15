// ── Traefik Module ──────────────────────────────────────────────────────────
//
// API routes for managing Traefik dynamic routes and reading certificate info.
//
// Routes (all under /api/traefik, require auth):
//   GET    /routes                — list all active dynamic routes
//   PUT    /routes/:appName       — create or update a route for an app
//   DELETE /routes/:appName       — remove a route for an app
//   GET    /certificates          — list all ACME certificates
//   GET    /certificates/:domain  — get certificate info for a specific domain

import type { FastifyPluginAsync } from 'fastify';
import {
  writeRouteConfig,
  removeRouteConfig,
  listRouteConfigs,
  getCertificates,
  getCertificateForDomain,
} from '../services/traefik.js';

export const traefikModule: FastifyPluginAsync = async (app) => {
  // GET /api/traefik/routes — list all dynamic routes
  app.get('/routes', async () => {
    const routes = await listRouteConfigs();
    return { routes };
  });

  // PUT /api/traefik/routes/:appName — create/update a route
  app.put<{
    Params: { appName: string };
    Body: { domain: string; containerName: string; port: number };
  }>('/routes/:appName', async (request, reply) => {
    const { appName } = request.params;
    const { domain, containerName, port } = request.body ?? {};

    if (!domain || typeof domain !== 'string') {
      reply.code(400).send({ error: 'domain is required' });
      return;
    }
    if (!containerName || typeof containerName !== 'string') {
      reply.code(400).send({ error: 'containerName is required' });
      return;
    }
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'port must be a valid number (1-65535)' });
      return;
    }

    try {
      await writeRouteConfig(appName, domain, containerName, port);
      app.log.info({ appName, domain, containerName, port }, 'Traefik route created/updated');
      return { success: true, appName, domain };
    } catch (err) {
      app.log.error(err, `Failed to write Traefik route for ${appName}`);
      reply.code(500).send({
        error: err instanceof Error ? err.message : 'Failed to write route config',
      });
    }
  });

  // DELETE /api/traefik/routes/:appName — remove a route
  app.delete<{ Params: { appName: string } }>('/routes/:appName', async (request, reply) => {
    const { appName } = request.params;

    try {
      await removeRouteConfig(appName);
      app.log.info({ appName }, 'Traefik route removed');
      return { success: true, appName };
    } catch (err) {
      app.log.error(err, `Failed to remove Traefik route for ${appName}`);
      reply.code(500).send({
        error: err instanceof Error ? err.message : 'Failed to remove route config',
      });
    }
  });

  // GET /api/traefik/certificates — list all ACME certificates
  app.get('/certificates', async () => {
    const certificates = await getCertificates();
    return { certificates };
  });

  // GET /api/traefik/certificates/:domain — get certificate for a specific domain
  app.get<{ Params: { domain: string } }>('/certificates/:domain', async (request, reply) => {
    const { domain } = request.params;

    const cert = await getCertificateForDomain(domain);
    if (!cert) {
      reply.code(404).send({ error: `No certificate found for domain '${domain}'` });
      return;
    }
    return cert;
  });
};
