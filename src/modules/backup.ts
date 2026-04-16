// ── Backup Module ───────────────────────────────────────────────────────────
//
// GCS-backed backup primitives used by the platform manager.
// Routes (under /api/backup, require auth):
//   POST /gcs/test        — validate credentials and test write/delete access
//   POST /run             — execute a one-off database backup
//   GET  /jobs             — list all backup jobs
//   GET  /jobs/:id         — get a single backup job
//   POST /jobs             — create a backup job
//   PATCH /jobs/:id        — update a backup job
//   DELETE /jobs/:id       — delete a backup job
//   POST /jobs/:id/toggle  — enable/disable a backup job
//   POST /jobs/:id/run     — enqueue a job for immediate execution
//   GET  /history          — list backup history records
//   DELETE /history/:id    — delete a history record
//   GET  /scheduler/status — get scheduler status
//   POST /scheduler/credentials — set GCS credentials for scheduler

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { testGcsConnection } from '../services/backup-gcs.js';
import { runDatabaseBackupToGcs } from '../services/backup-runner.js';
import {
  BackupJobsStore,
  type BackupJobCreateInput,
  type BackupJobUpdateInput,
} from '../services/backup-jobs.js';
import { BackupScheduler } from '../services/backup-scheduler.js';

function backupError(reply: FastifyReply, err: unknown, code = 500): void {
  const message =
    err instanceof Error ? err.message : 'Backup operation failed';
  reply.code(code).send({ error: message });
}

export const backupModule: FastifyPluginAsync = async (app) => {
  // ── Init jobs store + scheduler ──────────────────────────────────────

  const jobsStore = new BackupJobsStore(app.config.statePath);
  jobsStore.init();

  const scheduler = new BackupScheduler(jobsStore, app.config);
  scheduler.start();

  app.addHook('onClose', async () => {
    scheduler.stop();
  });

  // ── GCS test ─────────────────────────────────────────────────────────

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

  // ── Manual backup run ────────────────────────────────────────────────

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

  // ── Jobs CRUD ────────────────────────────────────────────────────────

  app.get('/jobs', async () => {
    return jobsStore.listJobs();
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const job = jobsStore.getJob(request.params.id);
    if (!job) {
      reply.code(404).send({ error: 'Job not found' });
      return;
    }
    return job;
  });

  app.post<{ Body: BackupJobCreateInput }>('/jobs', async (request, reply) => {
    try {
      return jobsStore.createJob(request.body);
    } catch (err) {
      backupError(reply, err, 400);
    }
  });

  app.patch<{ Params: { id: string }; Body: BackupJobUpdateInput }>(
    '/jobs/:id',
    async (request, reply) => {
      try {
        return jobsStore.updateJob(request.params.id, request.body);
      } catch (err) {
        backupError(reply, err, 404);
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    async (request, reply) => {
      try {
        jobsStore.deleteJob(request.params.id);
        reply.code(204).send();
      } catch (err) {
        backupError(reply, err, 404);
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/jobs/:id/toggle',
    async (request, reply) => {
      try {
        return jobsStore.toggleJob(request.params.id, request.body.enabled);
      } catch (err) {
        backupError(reply, err, 404);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/run',
    async (request, reply) => {
      try {
        scheduler.enqueueJob(request.params.id);
        reply.code(202).send({ queued: true });
      } catch (err) {
        backupError(reply, err, 404);
      }
    }
  );

  // ── History ──────────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string; database?: string } }>(
    '/history',
    async (request) => {
      const limit = request.query.limit
        ? parseInt(request.query.limit, 10)
        : undefined;
      return jobsStore.listHistory({
        limit,
        database: request.query.database,
      });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/history/:id',
    async (request, reply) => {
      try {
        jobsStore.deleteHistoryRecord(request.params.id);
        reply.code(204).send();
      } catch (err) {
        backupError(reply, err, 404);
      }
    }
  );

  // ── Scheduler status + credentials ───────────────────────────────────

  app.get('/scheduler/status', async () => {
    return scheduler.getStatus();
  });

  app.post<{
    Body: { credentialsJson: string; bucket: string; prefix?: string };
  }>('/scheduler/credentials', async (request, reply) => {
    const { credentialsJson, bucket, prefix } = request.body ?? {};

    if (!credentialsJson || !bucket) {
      reply
        .code(400)
        .send({ error: 'credentialsJson and bucket are required' });
      return;
    }

    scheduler.setCredentials(credentialsJson, bucket, prefix);
    return { configured: true };
  });
};
