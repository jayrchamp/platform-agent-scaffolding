// ── Network Module ────────────────────────────────────────────────────────────
//
// Manages host-level network access controls for the VPS.
// Primarily used to block/unblock the original droplet IP when a Reserved IP
// is in use — so that only the Reserved IP is publicly accessible.
//
// Routes (under /api/network, require auth):
//   POST /block-original-ip   — apply iptables rules to block the original IP
//   POST /unblock-original-ip — remove iptables rules (restore full access)
//   GET  /original-ip-status  — check current status of the original IP

import type { FastifyPluginAsync } from 'fastify';
import {
  blockIp,
  unblockIp,
  checkIpBlockStatus,
} from '../services/network.js';

export const networkModule: FastifyPluginAsync = async (app) => {
  // POST /api/network/block-original-ip
  // Applies iptables INPUT rules to drop inbound traffic on the original IP,
  // except for essential services (SSH on port 22, agent port).
  app.post<{ Body: { originalIp: string; agentPort?: number } }>(
    '/block-original-ip',
    async (request, reply) => {
      const { originalIp, agentPort } = request.body ?? {};

      if (!originalIp) {
        reply.code(400).send({ error: 'originalIp is required' });
        return;
      }

      if (!isValidPublicIp(originalIp)) {
        reply.code(400).send({ error: 'Invalid or private IP address' });
        return;
      }

      try {
        const result = await blockIp(originalIp, agentPort);
        return result;
      } catch (err) {
        app.log.error(err, `Failed to block original IP ${originalIp}`);
        reply.code(500).send({
          success: false,
          message: err instanceof Error ? err.message : 'Failed to apply iptables rules',
        });
      }
    },
  );

  // POST /api/network/unblock-original-ip
  // Removes iptables rules previously set by block-original-ip.
  app.post<{ Body: { originalIp: string } }>(
    '/unblock-original-ip',
    async (request, reply) => {
      const { originalIp } = request.body ?? {};

      if (!originalIp) {
        reply.code(400).send({ error: 'originalIp is required' });
        return;
      }

      if (!isValidPublicIp(originalIp)) {
        reply.code(400).send({ error: 'Invalid or private IP address' });
        return;
      }

      try {
        const result = await unblockIp(originalIp);
        return result;
      } catch (err) {
        app.log.error(err, `Failed to unblock original IP ${originalIp}`);
        reply.code(500).send({
          success: false,
          message: err instanceof Error ? err.message : 'Failed to remove iptables rules',
        });
      }
    },
  );

  // GET /api/network/original-ip-status?ip=x.x.x.x
  // Returns the current block status of the given IP.
  app.get<{ Querystring: { ip: string } }>(
    '/original-ip-status',
    async (request, reply) => {
      const { ip } = request.query;

      if (!ip) {
        reply.code(400).send({ error: 'ip query param is required' });
        return;
      }

      try {
        const status = await checkIpBlockStatus(ip);
        return { ip, status };
      } catch (err) {
        app.log.error(err, `Failed to check IP status for ${ip}`);
        return { ip, status: 'unknown' as const };
      }
    },
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rejects private / loopback / link-local ranges to prevent shooting
 * ourselves in the foot with iptables on internal interfaces.
 */
function isValidPublicIp(ip: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return false;
  // 10.x.x.x
  if (parts[0] === 10) return false;
  // 172.16-31.x.x
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  // 192.168.x.x
  if (parts[0] === 192 && parts[1] === 168) return false;
  // 127.x.x.x (loopback)
  if (parts[0] === 127) return false;
  // 169.254.x.x (link-local)
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}
