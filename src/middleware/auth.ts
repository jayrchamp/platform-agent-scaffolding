// ── Auth Middleware ──────────────────────────────────────────────────────────
//
// Validates Bearer token on every request within the /api scope.
// The token is generated during VPS bootstrap and stored in agent.yaml.
//
// Story 5.5 will add: token rotation endpoint, input validation, rate limit tuning.

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AgentConfig } from '../config.js';

export function authMiddleware(config: AgentConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      reply.code(401).send({ error: 'Missing Authorization header' });
      return;
    }

    // Expect "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      reply.code(401).send({ error: 'Invalid Authorization format — expected: Bearer <token>' });
      return;
    }

    const token = parts[1]!;

    if (!timingSafeEqual(token, config.authToken)) {
      reply.code(403).send({ error: 'Invalid token' });
      return;
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Constant-time string comparison (prevents timing attacks on token validation) */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');

  // Different lengths → hash both to avoid leaking length info
  if (bufA.length !== bufB.length) {
    // Still do the comparison to keep constant time, but always return false
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}
