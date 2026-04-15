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
//   PUT    /origin-cert/:domain   — write Origin Certificate files
//   DELETE /origin-cert/:domain   — remove Origin Certificate files
//   GET    /origin-certs          — list all installed Origin Certificates

import type { FastifyPluginAsync } from 'fastify';
import {
  writeRouteConfig,
  removeRouteConfig,
  listRouteConfigs,
  getCertificates,
  getCertificateForDomain,
  writeOriginCert,
  removeOriginCert,
  listOriginCerts,
} from '../services/traefik.js';
import { findAppContainer } from '../services/apps.js';

export const traefikModule: FastifyPluginAsync = async (app) => {
  // GET /api/traefik/routes — list all dynamic routes
  app.get('/routes', async () => {
    const routes = await listRouteConfigs();
    return { routes };
  });

  // PUT /api/traefik/routes/:appName — create/update a route
  app.put<{
    Params: { appName: string };
    Body: {
      domain: string;
      containerName?: string;
      port: number;
      sslMode?: 'letsencrypt' | 'origin';
    };
  }>('/routes/:appName', async (request, reply) => {
    const { appName } = request.params;
    const { domain, port, sslMode } = request.body ?? {};
    let { containerName } = request.body ?? {};

    if (!domain || typeof domain !== 'string') {
      reply.code(400).send({ error: 'domain is required' });
      return;
    }
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'port must be a valid number (1-65535)' });
      return;
    }

    // Auto-resolve container name if not provided
    if (!containerName) {
      try {
        const container = await findAppContainer(appName);
        if (!container) {
          reply
            .code(404)
            .send({ error: `No container found for app '${appName}'` });
          return;
        }
        containerName = container.name.replace(/^\//, '');
      } catch (err) {
        reply.code(500).send({
          error: `Failed to resolve container: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    try {
      await writeRouteConfig(appName, domain, containerName, port, sslMode);
      app.log.info(
        {
          appName,
          domain,
          containerName,
          port,
          sslMode: sslMode ?? 'letsencrypt',
        },
        'Traefik route created/updated'
      );
      return { success: true, appName, domain };
    } catch (err) {
      app.log.error(err, `Failed to write Traefik route for ${appName}`);
      reply.code(500).send({
        error:
          err instanceof Error ? err.message : 'Failed to write route config',
      });
    }
  });

  // DELETE /api/traefik/routes/:appName — remove a route
  app.delete<{ Params: { appName: string } }>(
    '/routes/:appName',
    async (request, reply) => {
      const { appName } = request.params;

      try {
        await removeRouteConfig(appName);
        app.log.info({ appName }, 'Traefik route removed');
        return { success: true, appName };
      } catch (err) {
        app.log.error(err, `Failed to remove Traefik route for ${appName}`);
        reply.code(500).send({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to remove route config',
        });
      }
    }
  );

  // GET /api/traefik/certificates — list all ACME certificates
  app.get('/certificates', async () => {
    const certificates = await getCertificates();
    return { certificates };
  });

  // GET /api/traefik/certificates/:domain — get certificate for a specific domain
  app.get<{ Params: { domain: string } }>(
    '/certificates/:domain',
    async (request, reply) => {
      const { domain } = request.params;

      const cert = await getCertificateForDomain(domain);
      if (!cert) {
        reply
          .code(404)
          .send({ error: `No certificate found for domain '${domain}'` });
        return;
      }
      return cert;
    }
  );

  // ── Origin Certificate management ──────────────────────────────────────

  // PUT /api/traefik/origin-cert/:domain — write origin cert + key files
  app.put<{
    Params: { domain: string };
    Body: { certPem: string; keyPem: string };
  }>('/origin-cert/:domain', async (request, reply) => {
    const { domain } = request.params;
    const { certPem, keyPem } = request.body ?? {};

    if (!certPem || typeof certPem !== 'string') {
      reply.code(400).send({ error: 'certPem is required' });
      return;
    }
    if (!keyPem || typeof keyPem !== 'string') {
      reply.code(400).send({ error: 'keyPem is required' });
      return;
    }

    try {
      await writeOriginCert(domain, certPem, keyPem);
      app.log.info({ domain }, 'Origin certificate written');
      return { success: true, domain };
    } catch (err) {
      app.log.error(err, `Failed to write origin cert for ${domain}`);
      reply.code(500).send({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to write origin certificate',
      });
    }
  });

  // DELETE /api/traefik/origin-cert/:domain — remove origin cert files
  app.delete<{ Params: { domain: string } }>(
    '/origin-cert/:domain',
    async (request, reply) => {
      const { domain } = request.params;

      try {
        await removeOriginCert(domain);
        app.log.info({ domain }, 'Origin certificate removed');
        return { success: true, domain };
      } catch (err) {
        app.log.error(err, `Failed to remove origin cert for ${domain}`);
        reply.code(500).send({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to remove origin certificate',
        });
      }
    }
  );

  // GET /api/traefik/origin-certs — list all installed origin certificates
  app.get('/origin-certs', async () => {
    const certificates = await listOriginCerts();
    return { certificates };
  });
};
