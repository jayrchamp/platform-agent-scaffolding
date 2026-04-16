// ── PostgreSQL Module ────────────────────────────────────────────────────────
//
// Routes for managing the shared PostgreSQL instance.
// All routes require Bearer token auth (enforced by the parent scope in app.ts).
//
// Routes (all under /api/postgres):
//
// Story 6.1 — Database CRUD
//   GET    /databases                       — list databases
//   POST   /databases                       — create database (body: { name, owner?, dryRun? })
//   DELETE /databases/:name                 — drop database (?dryRun=true)
//
// Story 6.2 — User Management
//   GET    /users                           — list users
//   POST   /users                           — create user (body: { username, password, privilege, database?, dryRun? })
//   DELETE /users/:username                 — drop user (?dryRun=true)
//   POST   /users/:username/rotate-password — rotate password (body: { newPassword })
//
// Story 6.3 — Database Detail
//   GET    /databases/:name                 — full database detail (tables, slow queries)
//   POST   /databases/:name/vacuum          — trigger VACUUM ANALYZE (body: { schema, table, full? })
//
// Story 6.4 — Instance Health
//   GET    /health                          — instance health + connection stats
//
// Story 6.5 — Connection History
//   GET    /connections/history             — ring-buffer history + recommendations
//
// Story 6.6 — Configuration
//   GET    /config                          — list managed params with current values
//   PATCH  /config                          — set a param (body: { name, value })
//   GET    /config/suggestions              — auto-suggestions (?ramMb=4096&vCpus=2)

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  listDatabases,
  createDatabase,
  dropDatabase,
  dryRunCreateDatabase,
  dryRunDropDatabase,
  listUsers,
  createUser,
  dropUser,
  rotatePassword,
  dryRunCreateUser,
  dryRunDropUser,
  getDatabaseDetail,
  triggerVacuum,
  getInstanceHealth,
  getConnectionHistory,
  getPoolingRecommendations,
  getPgSettings,
  setPgSetting,
  suggestPgSettings,
  MANAGED_PG_PARAMS,
  testPgConnection,
  type UserPrivilege,
} from '../services/postgres.js';

// ── Helper ─────────────────────────────────────────────────────────────────

function pgError(reply: FastifyReply, err: unknown, code = 500): void {
  const message =
    err instanceof Error ? err.message : 'PostgreSQL operation failed';
  reply.code(code).send({ error: message });
}

// ── Module ─────────────────────────────────────────────────────────────────

export const postgresModule: FastifyPluginAsync = async (app) => {
  // ── Story 6.1 — Databases ─────────────────────────────────────────────

  // GET /api/postgres/databases
  app.get('/databases', async (_request, reply) => {
    try {
      return { databases: await listDatabases() };
    } catch (err) {
      pgError(reply, err);
    }
  });

  // GET /api/postgres/databases/:name
  app.get<{ Params: { name: string } }>(
    '/databases/:name',
    async (request, reply) => {
      const { name } = request.params;
      try {
        return await getDatabaseDetail(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.includes('not found')) {
          reply.code(404).send({ error: message });
        } else {
          pgError(reply, err);
        }
      }
    }
  );

  // POST /api/postgres/databases
  app.post<{
    Body: { name: string; owner?: string; dryRun?: boolean };
  }>('/databases', async (request, reply) => {
    const { name, owner, dryRun = false } = request.body ?? {};

    if (!name) {
      reply.code(400).send({ error: 'name is required' });
      return;
    }

    try {
      if (dryRun) {
        const result = await dryRunCreateDatabase(name, owner);
        return result;
      }
      const db = await createDatabase(name, owner);
      reply.code(201).send(db);
    } catch (err) {
      pgError(reply, err);
    }
  });

  // DELETE /api/postgres/databases/:name
  app.delete<{
    Params: { name: string };
    Querystring: { dryRun?: string };
  }>('/databases/:name', async (request, reply) => {
    const { name } = request.params;
    const dryRun = request.query.dryRun === 'true';

    try {
      if (dryRun) {
        const result = await dryRunDropDatabase(name);
        return result;
      }
      await dropDatabase(name);
      reply.code(204).send();
    } catch (err) {
      pgError(reply, err);
    }
  });

  // POST /api/postgres/databases/:name/vacuum
  app.post<{
    Params: { name: string };
    Body: { schema?: string; table: string; full?: boolean };
  }>('/databases/:name/vacuum', async (request, reply) => {
    const { name } = request.params;
    const { schema = 'public', table, full = false } = request.body ?? {};

    if (!table) {
      reply.code(400).send({ error: 'table is required' });
      return;
    }

    try {
      await triggerVacuum(name, schema, table, full);
      return {
        message: `VACUUM${full ? ' FULL' : ''} ANALYZE "${schema}"."${table}" completed`,
      };
    } catch (err) {
      pgError(reply, err);
    }
  });

  // ── Story 6.2 — Users ─────────────────────────────────────────────────

  // GET /api/postgres/users
  app.get('/users', async (_request, reply) => {
    try {
      return { users: await listUsers() };
    } catch (err) {
      pgError(reply, err);
    }
  });

  // POST /api/postgres/users
  app.post<{
    Body: {
      username: string;
      password?: string;
      privilege: UserPrivilege;
      database?: string;
      dryRun?: boolean;
    };
  }>('/users', async (request, reply) => {
    const {
      username,
      password,
      privilege = 'readwrite',
      database,
      dryRun = false,
    } = request.body ?? {};

    if (!username) {
      reply.code(400).send({ error: 'username is required' });
      return;
    }

    const validPrivileges: UserPrivilege[] = ['readonly', 'readwrite', 'admin'];
    if (!validPrivileges.includes(privilege)) {
      reply
        .code(400)
        .send({
          error: `privilege must be one of: ${validPrivileges.join(', ')}`,
        });
      return;
    }

    try {
      if (dryRun) {
        const result = await dryRunCreateUser(username, privilege, database);
        return result;
      }

      if (!password) {
        reply
          .code(400)
          .send({ error: 'password is required when dryRun is false' });
        return;
      }

      const user = await createUser(username, password, privilege, database);
      reply.code(201).send(user);
    } catch (err) {
      pgError(reply, err);
    }
  });

  // DELETE /api/postgres/users/:username
  app.delete<{
    Params: { username: string };
    Querystring: { dryRun?: string };
  }>('/users/:username', async (request, reply) => {
    const { username } = request.params;
    const dryRun = request.query.dryRun === 'true';

    try {
      if (dryRun) {
        const result = await dryRunDropUser(username);
        return result;
      }
      await dropUser(username);
      reply.code(204).send();
    } catch (err) {
      pgError(reply, err);
    }
  });

  // POST /api/postgres/users/:username/rotate-password
  app.post<{
    Params: { username: string };
    Body: { newPassword: string };
  }>('/users/:username/rotate-password', async (request, reply) => {
    const { username } = request.params;
    const { newPassword } = request.body ?? {};

    if (!newPassword || newPassword.length < 16) {
      reply
        .code(400)
        .send({ error: 'newPassword must be at least 16 characters' });
      return;
    }

    try {
      await rotatePassword(username, newPassword);
      return { message: `Password rotated for user "${username}"` };
    } catch (err) {
      pgError(reply, err);
    }
  });

  // ── Story 6.4 — Instance Health ───────────────────────────────────────

  // GET /api/postgres/health
  app.get('/health', async (_request, reply) => {
    try {
      const health = await getInstanceHealth();
      return health;
    } catch (err) {
      // If PG is unreachable, return a degraded health response
      const message =
        err instanceof Error ? err.message : 'PostgreSQL unreachable';
      return {
        isRunning: false,
        version: '',
        uptime: '',
        connections: {
          active: 0,
          idle: 0,
          idleInTransaction: 0,
          waiting: 0,
          total: 0,
          max: 0,
          usagePercent: 0,
        },
        cacheHitRatio: 0,
        transactions: { commits: 0, rollbacks: 0 },
        databases: 0,
        postgresContainerName: 'platform-postgres',
        error: message,
      };
    }
  });

  // ── Story 6.5 — Connection History ────────────────────────────────────

  // GET /api/postgres/connections/history
  app.get('/connections/history', async () => {
    const history = getConnectionHistory();
    const recommendations = getPoolingRecommendations(history);
    return { history, recommendations };
  });

  // ── Story 6.6 — Configuration ─────────────────────────────────────────

  // GET /api/postgres/config
  app.get<{ Querystring: { params?: string } }>(
    '/config',
    async (request, reply) => {
      const paramList = request.query.params
        ? request.query.params.split(',').map((p) => p.trim())
        : MANAGED_PG_PARAMS;

      try {
        const settings = await getPgSettings(paramList);
        return { settings };
      } catch (err) {
        pgError(reply, err);
      }
    }
  );

  // PATCH /api/postgres/config
  app.patch<{
    Body: { name: string; value: string };
  }>('/config', async (request, reply) => {
    const { name, value } = request.body ?? {};

    if (!name || value === undefined || value === null) {
      reply.code(400).send({ error: 'name and value are required' });
      return;
    }

    if (
      !MANAGED_PG_PARAMS.includes(name as (typeof MANAGED_PG_PARAMS)[number])
    ) {
      reply.code(400).send({
        error: `Parameter "${name}" is not managed. Allowed: ${MANAGED_PG_PARAMS.join(', ')}`,
      });
      return;
    }

    try {
      const result = await setPgSetting(name, value);
      return {
        name,
        value,
        ...result,
        message: result.requiresRestart
          ? `Setting updated. PostgreSQL restart required to apply "${name}".`
          : `Setting "${name}" applied and reloaded.`,
      };
    } catch (err) {
      pgError(reply, err);
    }
  });

  // GET /api/postgres/config/suggestions
  app.get<{ Querystring: { ramMb?: string; vCpus?: string } }>(
    '/config/suggestions',
    async (request, reply) => {
      const ramMb = parseInt(request.query.ramMb ?? '0', 10);
      const vCpus = parseInt(request.query.vCpus ?? '0', 10);

      if (!ramMb || ramMb < 512) {
        reply
          .code(400)
          .send({ error: 'ramMb must be a positive integer >= 512' });
        return;
      }

      if (!vCpus || vCpus < 1) {
        reply
          .code(400)
          .send({ error: 'vCpus must be a positive integer >= 1' });
        return;
      }

      try {
        // Enrich suggestions with current values
        const suggestions = suggestPgSettings(ramMb, vCpus);
        const currentSettings = await getPgSettings(
          suggestions.map((s) => s.name)
        );
        const currentMap = new Map(
          currentSettings.map((s) => [
            s.name,
            s.setting + (s.unit ? s.unit : ''),
          ])
        );

        const enriched = suggestions.map((s) => ({
          ...s,
          currentValue: currentMap.get(s.name) ?? '',
        }));

        return { ramMb, vCpus, suggestions: enriched };
      } catch (err) {
        pgError(reply, err);
      }
    }
  );

  // ── Story 19.4 — Remote connection test ─────────────────────────────────

  // POST /api/postgres/test-connection
  app.post<{
    Body: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    };
  }>('/test-connection', async (request, reply) => {
    const { host, port, user, password, database } =
      request.body ?? ({} as any);

    if (!host || !port || !user || !password || !database) {
      return reply.status(400).send({
        error: 'All fields required: host, port, user, password, database',
      });
    }

    return testPgConnection({ host, port, user, password, database });
  });
};
