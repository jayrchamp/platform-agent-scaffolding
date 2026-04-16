// ── Backup Module ───────────────────────────────────────────────────────────
//
// GCS-backed backup primitives used by the platform manager.
// Routes (under /api/backup, require auth):
//   POST /gcs/test — validate credentials and test write/delete access to a bucket

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { testGcsConnection } from '../services/backup-gcs.js';
import { runDatabaseBackupToGcs } from '../services/backup-runner.js';

function backupError(reply: FastifyReply, err: unknown, code = 500): void {
  const message =
    err instanceof Error ? err.message : 'Backup operation failed';
  reply.code(code).send({ error: message });
}

export const backupModule: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: { credentialsJson: string; bucket: string; prefix?: string };
  }>('/gcs/test', async (request, reply) => {
    const { credentialsJson, bucket, prefix } = request.body ?? {};

    if (!credentialsJson) {
      reply.code(400).send({ error: 'credentialsJson is required' });
      return;
    }

    if (!bucket) {
      reply.code(400).send({ error: 'bucket is required' });
      return;
    }

    request.raw.setTimeout?.(60_000);

    try {
      return await testGcsConnection({
        credentialsJson,
        bucket,
        prefix,
      });
    } catch (err) {
      backupError(reply, err);
    }
  });

  app.post<{
    Body: {
      credentialsJson: string;
      bucket: string;
      prefix?: string;
      database: string;
      compression?: boolean;
    };
  }>('/run', async (request, reply) => {
    const { credentialsJson, bucket, prefix, database, compression } =
      request.body ?? {};

    if (!credentialsJson) {
      reply.code(400).send({ error: 'credentialsJson is required' });
      return;
    }

    if (!bucket) {
      reply.code(400).send({ error: 'bucket is required' });
      return;
    }

    if (!database) {
      reply.code(400).send({ error: 'database is required' });
      return;
    }

    request.raw.setTimeout?.(600_000);

    try {
      return await runDatabaseBackupToGcs(app.config, {
        credentialsJson,
        bucket,
        prefix,
        database,
        compression,
      });
    } catch (err) {
      backupError(reply, err);
    }
  });
};
