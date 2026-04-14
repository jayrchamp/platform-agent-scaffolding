// ── Apps Module ──────────────────────────────────────────────────────────────
//
// High-level app lifecycle actions. Uses AppSpec as the source of truth and
// orchestrates container creation/start/stop/restart via the apps service.
//
// Routes (all under /api/apps, require auth):
//   POST   /:name/deploy      — deploy (create container from spec + start)
//   POST   /:name/start       — start a stopped container
//   POST   /:name/stop        — stop a running container
//   POST   /:name/restart     — restart a running container
//   GET    /:name/logs        — tail container logs
//   GET    /:name/build-log   — read build log (streaming deploy output)
//   DELETE /:name             — delete app (container + volumes + appspec + builds + optional PG cleanup)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  deployApp,
  startApp,
  stopApp,
  restartApp,
  getAppLogs,
  findAppContainer,
} from '../services/apps.js';
import { containerAction } from '../services/docker.js';
import { getBuildLogPath } from '../services/build.js';

const exec = promisify(execFile);

export const appsModule: FastifyPluginAsync = async (app) => {
  const state = app.stateManager;
  const monitor = app.healthMonitor;

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

    const result = await deployApp(state, name, monitor);
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

    const result = await startApp(state, name, monitor);
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

    const result = await stopApp(state, name, monitor);
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

    const result = await restartApp(state, name, monitor);
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

  // GET /api/apps/:name/build-log — returns full content of the latest build log
  app.get<{ Params: { name: string } }>('/:name/build-log', async (request) => {
    const { name } = request.params;
    const logPath = getBuildLogPath(name);

    if (!existsSync(logPath)) {
      return { log: '', size: 0 };
    }

    try {
      const stat = statSync(logPath);
      const log = readFileSync(logPath, 'utf-8');
      return { log, size: stat.size };
    } catch {
      return { log: '', size: 0 };
    }
  });

  // DELETE /api/apps/:name — full teardown: container + volumes + appspec + builds + optional PG cleanup
  app.delete<{ Params: { name: string } }>('/:name', async (request, reply) => {
    const { name } = request.params;

    const spec = state.getAppSpec(name);
    if (!spec) {
      reply.code(404).send({ error: `AppSpec '${name}' not found` });
      return;
    }

    const errors: string[] = [];

    // 1. Stop and remove container + anonymous volumes
    try {
      const container = await findAppContainer(name);
      if (container) {
        await containerAction(container.id, 'remove', { removeVolumes: true });
      }
    } catch (err) {
      errors.push(`Container removal failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. PostgreSQL cleanup — drop database and user if configured
    if (spec.postgres) {
      const { dbName, user } = spec.postgres;
      if (dbName) {
        try {
          await exec('docker', [
            'exec', 'platform-postgres',
            'psql', '-U', 'postgres', '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
          ], { timeout: 30_000 });
        } catch (err) {
          errors.push(`PG database cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (user) {
        try {
          await exec('docker', [
            'exec', 'platform-postgres',
            'psql', '-U', 'postgres', '-c', `DROP USER IF EXISTS "${user}";`,
          ], { timeout: 30_000 });
        } catch (err) {
          errors.push(`PG user cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 3. Stop health monitoring + remove runtime state
    monitor.stopMonitoring(name);
    state.removeAppState(name);

    // 4. Remove AppSpec + all versions from disk
    state.deleteAppSpec(name);

    // 5. Remove build artifacts
    try {
      const buildsDir = app.stateManager.getBuildsPath(name);
      if (buildsDir && existsSync(buildsDir)) {
        rmSync(buildsDir, { recursive: true, force: true });
      }
    } catch {
      // Build dir cleanup is best-effort — don't fail the delete
    }

    // Log the operation
    state.logOperation({
      id: `op_delete_${name}_${Date.now()}`,
      type: 'delete_app',
      target: name,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: errors.length ? `Deleted with warnings: ${errors.join('; ')}` : 'Deleted successfully',
    });

    return { success: true, appName: name, action: 'delete', warnings: errors };
  });
};
