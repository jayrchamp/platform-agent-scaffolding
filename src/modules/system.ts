// ── System Module ───────────────────────────────────────────────────────────
//
// Exposes VPS system metrics: CPU, RAM, disk, network, processes, uptime.
// Full implementation in Story 5.2.

import type { FastifyPluginAsync } from 'fastify';

export const systemModule: FastifyPluginAsync = async (app) => {
  // GET /api/system/metrics — CPU %, RAM %, disk %, network I/O
  app.get('/metrics', async () => {
    // TODO: Story 5.2 — read from /proc, cache periodically
    return { stub: true, message: 'System metrics — not yet implemented (Story 5.2)' };
  });

  // GET /api/system/processes — top processes by CPU/RAM
  app.get('/processes', async () => {
    return { stub: true, message: 'Process list — not yet implemented (Story 5.2)' };
  });

  // GET /api/system/uptime — uptime + load average
  app.get('/uptime', async () => {
    return { stub: true, message: 'Uptime — not yet implemented (Story 5.2)' };
  });
};
