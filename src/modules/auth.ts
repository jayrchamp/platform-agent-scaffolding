// ── Auth Module ─────────────────────────────────────────────────────────────
//
// Secured endpoints for token management.
// These routes are INSIDE the /api scope (require current valid token).
//
// Routes (under /api/auth):
//   POST /rotate-token   — generate new token, update config on disk, return new token

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import yaml from 'js-yaml';

// ── Config file paths (same as config.ts) ──────────────────────────────────

const CONFIG_PATHS = [
  '/config/agent.yaml',
  '/opt/platform/agent/config/agent.yaml',
];

export const authModule: FastifyPluginAsync = async (app) => {
  // POST /api/auth/rotate-token
  app.post('/rotate-token', async (_request, reply) => {
    const newToken = randomBytes(48).toString('base64url');

    // Update config file on disk
    const updated = updateTokenInConfig(newToken);
    if (!updated) {
      reply.code(500).send({ error: 'Failed to update config file — no writable config found' });
      return;
    }

    // Update in-memory config so subsequent requests use new token
    app.config.authToken = newToken;

    app.log.info('Auth token rotated successfully');

    return {
      token: newToken,
      message: 'Token rotated. Update the token in your Electron app secrets.',
    };
  });
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function updateTokenInConfig(newToken: string): boolean {
  for (const configPath of CONFIG_PATHS) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = yaml.load(raw) as Record<string, unknown> | null;
      if (!config || typeof config !== 'object') continue;

      // Update the auth.token field
      if (!config.auth || typeof config.auth !== 'object') {
        config.auth = {};
      }
      (config.auth as Record<string, unknown>).token = newToken;

      writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }), 'utf-8');
      return true;
    } catch {
      // Try next path
    }
  }
  return false;
}
