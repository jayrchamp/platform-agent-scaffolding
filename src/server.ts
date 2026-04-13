// ── Agent Entry Point ───────────────────────────────────────────────────────
//
// Starts the Fastify server and handles graceful shutdown (SIGTERM/SIGINT).
// In production this runs inside a Docker container managed by systemd.

import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.authToken) {
    console.error('[FATAL] No auth token configured. Set AGENT_TOKEN env or auth.token in agent.yaml.');
    process.exit(1);
  }

  const app = await buildApp(config);

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal} — shutting down gracefully...`);
    try {
      await app.close();
      app.log.info('Server closed. Goodbye.');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Start listening ────────────────────────────────────────────────────

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Platform Agent v${config.version} listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.fatal(err, 'Failed to start server');
    process.exit(1);
  }
}

main();
