// ── Fastify App Builder ─────────────────────────────────────────────────────
//
// Creates and configures the Fastify instance with all plugins and modules.
// Separated from server.ts so tests can import the app without starting a listener.

import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';

import type { AgentConfig, ServerRole } from './config.js';
import { StateManager } from './services/state.js';
import { HealthMonitor } from './services/health-monitor.js';
import { initPostgres } from './services/postgres.js';
import {
  createPostgresClient,
  setPostgresClient,
  getPostgresClient,
} from './services/postgres-client.js';
import { authMiddleware } from './middleware/auth.js';
import { systemModule } from './modules/system.js';
import { dockerModule } from './modules/docker.js';
import { stateModule } from './modules/state.js';
import { authModule } from './modules/auth.js';
import { agentModule } from './modules/agent.js';
import { postgresModule } from './modules/postgres.js';
import { appsModule } from './modules/apps.js';
import { networkModule } from './modules/network.js';
import { traefikModule } from './modules/traefik.js';
import { backupModule } from './modules/backup.js';
import { workerModule } from './modules/worker.js';
import { setBuildsBase } from './services/build.js';
import { initTraefikPaths } from './services/traefik.js';
import { HttpAppServerClient } from './services/app-server-client.js';

// ── Module loading matrix ──────────────────────────────────────────────────

interface ModuleEntry {
  module: FastifyPluginAsync;
  prefix: string;
  roles: ServerRole[];
}

const ALL_ROLES: ServerRole[] = ['full', 'app', 'database', 'worker'];

const MODULE_REGISTRY: ModuleEntry[] = [
  // Universal — loaded for all roles
  { module: systemModule, prefix: '/system', roles: ALL_ROLES },
  { module: dockerModule, prefix: '/docker', roles: ALL_ROLES },
  { module: stateModule, prefix: '/state', roles: ALL_ROLES },
  { module: authModule, prefix: '/auth', roles: ALL_ROLES },
  { module: agentModule, prefix: '/agent', roles: ALL_ROLES },
  { module: networkModule, prefix: '/network', roles: ALL_ROLES },
  // Conditional
  { module: postgresModule, prefix: '/postgres', roles: ['full', 'database'] },
  { module: appsModule, prefix: '/apps', roles: ['full', 'app'] },
  { module: traefikModule, prefix: '/traefik', roles: ['full', 'app'] },
  { module: backupModule, prefix: '/backup', roles: ['full', 'database'] },
  { module: workerModule, prefix: '/worker', roles: ['worker'] },
];

// ── Build app ──────────────────────────────────────────────────────────────

export async function buildApp(config: AgentConfig): Promise<FastifyInstance> {
  // Default role to 'full' for backward compatibility (tests, legacy configs)
  const role: ServerRole = config.role || 'full';

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // ── Decorate with config ───────────────────────────────────────────────

  app.decorate('config', config);

  // ── Set builds directory from config ──────────────────────────────────

  setBuildsBase(config.statePath);
  initTraefikPaths(config.statePath);

  // ── State manager (init directories + load from disk) ──────────────────

  const stateManager = new StateManager(config.statePath);
  stateManager.init();
  app.decorate('stateManager', stateManager);

  // ── Health monitor (background polling for running apps) ──────────────

  const healthMonitor = new HealthMonitor(stateManager);
  healthMonitor.start();
  app.decorate('healthMonitor', healthMonitor);

  // Graceful shutdown: stop monitor before closing
  app.addHook('onClose', async () => {
    healthMonitor.stop();
  });

  // ── PostgreSQL client (only for roles that need it) ─────────────────────

  const needsPostgres =
    role === 'full' || role === 'database' || role === 'worker';
  if (needsPostgres) {
    const pgClient = createPostgresClient({
      mode: config.postgres.mode ?? 'local',
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
    });
    setPostgresClient(pgClient);
    // Legacy init for backward compatibility (existing tests use setPgPool)
    if (role !== 'worker') {
      initPostgres(config.postgres);
    }
  }

  // ── Rate limiting ──────────────────────────────────────────────────────

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });

  // ── Determine active modules for this role ─────────────────────────────

  const activeModules = MODULE_REGISTRY.filter((m) => m.roles.includes(role));
  const loadedModuleNames = activeModules.map((m) => m.prefix.replace('/', ''));

  // Store role and loaded modules for capabilities endpoint
  app.decorate('agentRole', role);
  app.decorate('loadedModules', loadedModuleNames);

  // ── Health endpoint (unauthenticated) ──────────────────────────────────

  app.get('/health', async () => {
    return {
      status: 'ok',
      version: config.version,
      role,
      uptime: Math.floor(process.uptime()),
    };
  });

  // ── Auth middleware (everything under /api requires Bearer token) ──────

  await app.register(
    async (authedScope) => {
      authedScope.addHook('onRequest', authMiddleware(config));

      // ── Register modules (filtered by role) ────────────────────────────

      for (const { module, prefix } of activeModules) {
        await authedScope.register(module, { prefix });
      }
    },
    { prefix: '/api' }
  );

  // ── Worker boot-time connectivity test (non-blocking) ──────────────────

  if (role === 'worker') {
    setTimeout(async () => {
      try {
        const pgClient = getPostgresClient();
        const available = await pgClient.isAvailable();
        app.log.info(
          `[worker] Database connectivity: ${available ? 'OK' : 'FAILED'}`
        );
      } catch (err) {
        app.log.warn(`[worker] Database connectivity check failed: ${err}`);
      }

      const client = new HttpAppServerClient();
      for (const server of config.appServers ?? []) {
        const result = await client.ping(server, config.authToken);
        app.log.info(
          `[worker] App server ${server.name} (${server.host}): ${result.reachable ? 'OK' : result.error}`
        );
      }
    }, 2000);
  }

  return app;
}

// ── Fastify type augmentation ──────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    config: AgentConfig;
    stateManager: StateManager;
    healthMonitor: HealthMonitor;
    agentRole: ServerRole;
    loadedModules: string[];
  }
}
