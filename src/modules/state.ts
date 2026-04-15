// ── State Module ────────────────────────────────────────────────────────────
//
// Versioned AppSpecs, operations, and agent version info.
//
// Routes (all under /api/state, require auth):
//   GET    /appspecs              — list all AppSpecs (current versions)
//   GET    /appspecs/:name        — get current AppSpec
//   PUT    /appspecs/:name        — create or update (creates new version)
//   DELETE /appspecs/:name        — delete AppSpec + all versions
//   GET    /appspecs/:name/meta   — get version metadata
//   GET    /appspecs/:name/versions          — list all versions
//   GET    /appspecs/:name/versions/:version — get specific version
//   POST   /appspecs/:name/rollback          — rollback to a previous version
//   GET    /appspecs/:name/diff              — diff between two versions
//   GET    /appspecs/:name/export            — export spec + meta
//   POST   /appspecs/import                  — import spec from another VPS
//   GET    /operations            — recent operations log
//   GET    /version               — agent + platform version

import type { FastifyPluginAsync } from 'fastify';
import type { AppSpec } from '../services/state.js';
import { findAppContainer } from '../services/apps.js';

export const stateModule: FastifyPluginAsync = async (app) => {
  const state = app.stateManager;
  const healthMonitor = app.healthMonitor;

  // ── CRUD ────────────────────────────────────────────────────────────────

  // GET /api/state/appspecs
  app.get('/appspecs', async () => {
    return { appspecs: state.listAppSpecs() };
  });

  // GET /api/state/appspecs/:name
  app.get<{ Params: { name: string } }>(
    '/appspecs/:name',
    async (request, reply) => {
      const spec = state.getAppSpec(request.params.name);
      if (!spec) {
        reply
          .code(404)
          .send({ error: `AppSpec '${request.params.name}' not found` });
        return;
      }
      return spec;
    }
  );

  // PUT /api/state/appspecs/:name
  app.put<{
    Params: { name: string };
    Body: Partial<AppSpec> & {
      changeDescription?: string;
      changedBy?: 'user' | 'system';
    };
  }>('/appspecs/:name', async (request, reply) => {
    const { name } = request.params;
    const body = request.body ?? {};

    const existing = state.getAppSpec(name);
    const buildStrategy =
      body.buildStrategy ?? existing?.buildStrategy ?? 'dockerfile';
    const image = body.image ?? existing?.image;

    // image is only required for 'image' strategy
    if (buildStrategy === 'image' && !image) {
      reply
        .code(400)
        .send({ error: "image is required when buildStrategy is 'image'" });
      return;
    }

    const spec: AppSpec = {
      ...existing,
      ...body,
      name, // name comes from URL, not body
      buildStrategy,
      image,
      desiredState: body.desiredState ?? existing?.desiredState ?? 'running',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Guard: hostPort must be unique across all apps
    if (spec.hostPort) {
      const conflict = state.checkHostPortConflict(spec.hostPort, name);
      if (conflict) {
        reply.code(409).send({
          error: `Port ${spec.hostPort} is already assigned to app '${conflict}'. Choose a different public port.`,
        });
        return;
      }
    }

    // Remove extra fields that aren't part of AppSpec
    const { changeDescription, changedBy, ...cleanBody } = body;
    void cleanBody;

    const version = state.saveAppSpec(spec, {
      changedBy: changedBy ?? 'user',
      changeDescription,
    });

    return { spec, version: version.version };
  });

  // DELETE /api/state/appspecs/:name
  app.delete<{ Params: { name: string } }>(
    '/appspecs/:name',
    async (request, reply) => {
      const deleted = state.deleteAppSpec(request.params.name);
      if (!deleted) {
        reply
          .code(404)
          .send({ error: `AppSpec '${request.params.name}' not found` });
        return;
      }
      return { deleted: true, name: request.params.name };
    }
  );

  // ── Versioning ──────────────────────────────────────────────────────────

  // GET /api/state/appspecs/:name/meta
  app.get<{ Params: { name: string } }>(
    '/appspecs/:name/meta',
    async (request, reply) => {
      const meta = state.getAppSpecMeta(request.params.name);
      if (!meta) {
        reply
          .code(404)
          .send({ error: `AppSpec '${request.params.name}' not found` });
        return;
      }
      return meta;
    }
  );

  // GET /api/state/appspecs/:name/versions
  app.get<{ Params: { name: string } }>(
    '/appspecs/:name/versions',
    async (request, reply) => {
      const meta = state.getAppSpecMeta(request.params.name);
      if (!meta) {
        reply
          .code(404)
          .send({ error: `AppSpec '${request.params.name}' not found` });
        return;
      }

      const versions = state.getVersionHistory(request.params.name);
      return { versions };
    }
  );

  // GET /api/state/appspecs/:name/versions/:version
  app.get<{
    Params: { name: string; version: string };
  }>('/appspecs/:name/versions/:version', async (request, reply) => {
    const versionNum = parseInt(request.params.version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      reply.code(400).send({ error: 'Invalid version number' });
      return;
    }

    const version = state.getVersion(request.params.name, versionNum);
    if (!version) {
      reply
        .code(404)
        .send({
          error: `Version ${versionNum} not found for '${request.params.name}'`,
        });
      return;
    }
    return version;
  });

  // POST /api/state/appspecs/:name/rollback
  app.post<{
    Params: { name: string };
    Body: { toVersion: number };
  }>('/appspecs/:name/rollback', async (request, reply) => {
    const { name } = request.params;
    const { toVersion } = request.body ?? {};

    if (!toVersion || typeof toVersion !== 'number' || toVersion < 1) {
      reply
        .code(400)
        .send({
          error: 'toVersion is required and must be a positive integer',
        });
      return;
    }

    const result = state.rollbackAppSpec(name, toVersion);
    if (!result) {
      reply
        .code(404)
        .send({ error: `Version ${toVersion} not found for '${name}'` });
      return;
    }

    return {
      spec: result.spec,
      version: result.version,
      rolledBackFrom: toVersion,
    };
  });

  // GET /api/state/appspecs/:name/diff?from=1&to=2
  app.get<{
    Params: { name: string };
    Querystring: { from?: string; to?: string };
  }>('/appspecs/:name/diff', async (request, reply) => {
    const { name } = request.params;
    const from = parseInt(request.query.from ?? '', 10);
    const to = parseInt(request.query.to ?? '', 10);

    if (isNaN(from) || isNaN(to) || from < 1 || to < 1) {
      reply
        .code(400)
        .send({
          error:
            'Query params "from" and "to" are required (positive integers)',
        });
      return;
    }

    const diff = state.diffVersions(name, from, to);
    if (!diff) {
      reply
        .code(404)
        .send({
          error: `Could not compute diff for '${name}' between versions ${from} and ${to}`,
        });
      return;
    }

    return { from, to, diff };
  });

  // ── Export / Import ─────────────────────────────────────────────────────

  // GET /api/state/appspecs/:name/export
  app.get<{ Params: { name: string } }>(
    '/appspecs/:name/export',
    async (request, reply) => {
      const exported = state.exportAppSpec(request.params.name);
      if (!exported) {
        reply
          .code(404)
          .send({ error: `AppSpec '${request.params.name}' not found` });
        return;
      }
      return exported;
    }
  );

  // POST /api/state/appspecs/import
  app.post<{
    Body: { spec: AppSpec };
  }>('/appspecs/import', async (request, reply) => {
    const { spec } = request.body ?? {};

    if (!spec?.name || !spec?.image) {
      reply.code(400).send({ error: 'spec.name and spec.image are required' });
      return;
    }

    // Check for name conflict
    const existing = state.getAppSpec(spec.name);
    if (existing) {
      reply
        .code(409)
        .send({ error: `AppSpec '${spec.name}' already exists on this VPS` });
      return;
    }

    const version = state.importAppSpec(spec);
    return { spec: version.spec, version: version.version };
  });

  // ── App Runtime State ────────────────────────────────────────────────────

  // GET /api/state/apps/states
  app.get('/apps/states', async () => {
    const states = state.listAppStates();

    // Enrich each state with container port info
    const enriched = await Promise.all(
      states.map(async (s) => {
        try {
          const container = await findAppContainer(s.name);
          if (container) {
            return {
              ...s,
              containerId: container.id,
              ports: container.ports,
              containerStatus: container.status,
            };
          }
        } catch {
          /* skip enrichment */
        }
        return s;
      })
    );

    return { states: enriched };
  });

  // GET /api/state/apps/:name/state
  app.get<{ Params: { name: string } }>(
    '/apps/:name/state',
    async (request, reply) => {
      const appState = state.getAppState(request.params.name);
      if (!appState) {
        reply
          .code(404)
          .send({ error: `No runtime state for '${request.params.name}'` });
        return;
      }

      // Enrich with container info (ports, container ID)
      try {
        const container = await findAppContainer(request.params.name);
        if (container) {
          return {
            ...appState,
            containerId: container.id,
            ports: container.ports,
            containerStatus: container.status,
          };
        }
      } catch {
        // Docker unavailable — return state without enrichment
      }

      return appState;
    }
  );

  // POST /api/state/apps/:name/transition
  app.post<{
    Params: { name: string };
    Body: { state: string; error?: string };
  }>('/apps/:name/transition', async (request, reply) => {
    const { name } = request.params;
    const { state: newState, error: errorMsg } = request.body ?? {};

    if (!newState) {
      reply.code(400).send({ error: 'state is required' });
      return;
    }

    const result = state.transitionAppState(
      name,
      newState as import('../services/state.js').AppActualState,
      errorMsg
    );

    // Restart health monitoring on transition to 'running' so the monitor
    // picks up the new container (e.g. after a Kamal redeploy with a new SHA).
    if (result && newState === 'running') {
      healthMonitor?.stopMonitoring(name);
      healthMonitor?.startMonitoring(name);
    }

    if (!result) {
      const current = state.getAppState(name);
      reply.code(422).send({
        error: `Invalid transition: ${current?.state ?? 'none'} → ${newState}`,
        currentState: current?.state ?? null,
        requestedState: newState,
      });
      return;
    }

    return result;
  });

  // ── Operations & Version ────────────────────────────────────────────────

  // GET /api/state/operations
  app.get<{ Querystring: { limit?: string } }>(
    '/operations',
    async (request) => {
      const limit = Math.min(
        parseInt(request.query.limit ?? '50', 10) || 50,
        200
      );
      return { operations: state.getRecentOperations(limit) };
    }
  );

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
