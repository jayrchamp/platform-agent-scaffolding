// ── Fastify App Builder ─────────────────────────────────────────────────────
//
// Creates and configures the Fastify instance with all plugins and modules.
// Separated from server.ts so tests can import the app without starting a listener.

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

import type { AgentConfig } from './config.js';
import { StateManager } from './services/state.js';
import { initPostgres } from './services/postgres.js';
import { authMiddleware } from './middleware/auth.js';
import { systemModule } from './modules/system.js';
import { dockerModule } from './modules/docker.js';
import { stateModule } from './modules/state.js';
import { authModule } from './modules/auth.js';
import { agentModule } from './modules/agent.js';
import { postgresModule } from './modules/postgres.js';
import { appsModule } from './modules/apps.js';

// ── Build app ──────────────────────────────────────────────────────────────

export async function buildApp(config: AgentConfig): Promise<FastifyInstance> {
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

  // ── State manager (init directories + load from disk) ──────────────────

  const stateManager = new StateManager(config.statePath);
  stateManager.init();
  app.decorate('stateManager', stateManager);

  // ── PostgreSQL pool (non-blocking — connects lazily on first query) ────

  initPostgres(config.postgres);

  // ── Rate limiting ──────────────────────────────────────────────────────

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });

  // ── Health endpoint (unauthenticated) ──────────────────────────────────

  app.get('/health', async () => {
    return {
      status: 'ok',
      version: config.version,
      uptime: Math.floor(process.uptime()),
    };
  });

  // ── Auth middleware (everything under /api requires Bearer token) ──────

  await app.register(async (authedScope) => {
    authedScope.addHook('onRequest', authMiddleware(config));

    // ── Register modules ───────────────────────────────────────────────

    await authedScope.register(systemModule, { prefix: '/system' });
    await authedScope.register(dockerModule, { prefix: '/docker' });
    await authedScope.register(stateModule, { prefix: '/state' });
    await authedScope.register(authModule, { prefix: '/auth' });
    await authedScope.register(agentModule, { prefix: '/agent' });
    await authedScope.register(postgresModule, { prefix: '/postgres' });
    await authedScope.register(appsModule, { prefix: '/apps' });
  }, { prefix: '/api' });

  return app;
}

// ── Fastify type augmentation ──────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    config: AgentConfig;
    stateManager: StateManager;
  }
}
