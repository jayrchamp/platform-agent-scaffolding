import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupJobsStore } from '../src/services/backup-jobs.js';

let tmpDir: string;
let store: BackupJobsStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'backup-jobs-test-'));
  store = new BackupJobsStore(tmpDir);
  store.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BackupJobsStore — Jobs CRUD', () => {
  it('creates a daily backup job', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    expect(job.id).toBeTruthy();
    expect(job.enabled).toBe(true);
    expect(job.scope).toBe('database');
    expect(job.databaseName).toBe('app_db');
    expect(job.frequency).toBe('daily');
    expect(job.hourUtc).toBe(3);
    expect(job.minuteUtc).toBe(0);
    expect(job.retentionDays).toBe(14);
    expect(job.compression).toBe(true);
  });

  it('creates a weekly backup job', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'weekly',
      hourUtc: 2,
      minuteUtc: 30,
      weekDayUtc: 0,
    });

    expect(job.frequency).toBe('weekly');
    expect(job.weekDayUtc).toBe(0);
  });

  it('creates an instance-level job (no databaseName required)', () => {
    const job = store.createJob({
      scope: 'instance',
      frequency: 'daily',
      hourUtc: 4,
      minuteUtc: 0,
    });

    expect(job.scope).toBe('instance');
    expect(job.databaseName).toBeUndefined();
  });

  it('lists all jobs', () => {
    store.createJob({
      scope: 'database',
      databaseName: 'db1',
      frequency: 'daily',
      hourUtc: 1,
      minuteUtc: 0,
    });
    store.createJob({
      scope: 'database',
      databaseName: 'db2',
      frequency: 'daily',
      hourUtc: 2,
      minuteUtc: 0,
    });

    expect(store.listJobs()).toHaveLength(2);
  });

  it('gets a job by id', () => {
    const created = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    const fetched = store.getJob(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('updates a job', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    const updated = store.updateJob(job.id, {
      hourUtc: 5,
      retentionDays: 30,
    });

    expect(updated.hourUtc).toBe(5);
    expect(updated.retentionDays).toBe(30);
    expect(updated.updatedAt).toBeTruthy();
  });

  it('deletes a job', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    store.deleteJob(job.id);
    expect(store.listJobs()).toHaveLength(0);
    expect(store.getJob(job.id)).toBeUndefined();
  });

  it('toggles a job', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    expect(job.enabled).toBe(true);
    const toggled = store.toggleJob(job.id, false);
    expect(toggled.enabled).toBe(false);
  });

  it('throws when deleting non-existent job', () => {
    expect(() => store.deleteJob('nonexistent')).toThrow('not found');
  });

  it('throws when updating non-existent job', () => {
    expect(() => store.updateJob('nonexistent', { hourUtc: 5 })).toThrow(
      'not found'
    );
  });
});

describe('BackupJobsStore — Validation', () => {
  it('rejects database scope without databaseName', () => {
    expect(() =>
      store.createJob({
        scope: 'database',
        frequency: 'daily',
        hourUtc: 3,
        minuteUtc: 0,
      })
    ).toThrow('databaseName is required');
  });

  it('rejects invalid database name', () => {
    expect(() =>
      store.createJob({
        scope: 'database',
        databaseName: 'DROP TABLE',
        frequency: 'daily',
        hourUtc: 3,
        minuteUtc: 0,
      })
    ).toThrow('invalid');
  });

  it('rejects hourUtc out of range', () => {
    expect(() =>
      store.createJob({
        scope: 'instance',
        frequency: 'daily',
        hourUtc: 25,
        minuteUtc: 0,
      })
    ).toThrow('hourUtc');
  });

  it('rejects minuteUtc out of range', () => {
    expect(() =>
      store.createJob({
        scope: 'instance',
        frequency: 'daily',
        hourUtc: 3,
        minuteUtc: 61,
      })
    ).toThrow('minuteUtc');
  });

  it('rejects weekly without weekDayUtc', () => {
    expect(() =>
      store.createJob({
        scope: 'instance',
        frequency: 'weekly',
        hourUtc: 3,
        minuteUtc: 0,
      })
    ).toThrow('weekDayUtc');
  });

  it('rejects cron without cronExpr', () => {
    expect(() =>
      store.createJob({
        scope: 'instance',
        frequency: 'cron',
        hourUtc: 3,
        minuteUtc: 0,
      })
    ).toThrow('cronExpr');
  });
});

describe('BackupJobsStore — History', () => {
  it('adds and lists history records', () => {
    store.addHistoryRecord({
      id: 'rec-1',
      jobId: 'job-1',
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'my-bucket',
      objectPath: 'backups/test.sql.gz',
      checksumSha256: 'abc',
      compressed: true,
      sizeBytes: 1234,
      startedAt: '2026-04-15T03:00:00Z',
      endedAt: '2026-04-15T03:00:30Z',
      durationMs: 30000,
      status: 'success',
      trigger: 'scheduled',
    });

    const records = store.listHistory();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe('rec-1');
  });

  it('filters history by database', () => {
    store.addHistoryRecord({
      id: 'rec-1',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: 'p',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 100,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'manual',
    });
    store.addHistoryRecord({
      id: 'rec-2',
      scope: 'database',
      databaseName: 'db2',
      bucket: 'b',
      objectPath: 'p2',
      checksumSha256: 'c2',
      compressed: true,
      sizeBytes: 200,
      startedAt: '2026-04-15T02:00:00Z',
      endedAt: '2026-04-15T02:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    expect(store.listHistory({ database: 'db1' })).toHaveLength(1);
    expect(store.listHistory({ database: 'db2' })).toHaveLength(1);
    expect(store.listHistory()).toHaveLength(2);
  });

  it('limits history results', () => {
    for (let i = 0; i < 5; i++) {
      store.addHistoryRecord({
        id: `rec-${i}`,
        scope: 'database',
        databaseName: 'app_db',
        bucket: 'b',
        objectPath: `p${i}`,
        checksumSha256: `c${i}`,
        compressed: true,
        sizeBytes: 100,
        startedAt: new Date(2026, 3, 15, i).toISOString(),
        endedAt: new Date(2026, 3, 15, i, 0, 10).toISOString(),
        durationMs: 10000,
        status: 'success',
        trigger: 'scheduled',
      });
    }

    expect(store.listHistory({ limit: 2 })).toHaveLength(2);
  });

  it('deletes a history record', () => {
    store.addHistoryRecord({
      id: 'rec-del',
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'b',
      objectPath: 'p',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 100,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'manual',
    });

    store.deleteHistoryRecord('rec-del');
    expect(store.listHistory()).toHaveLength(0);
  });

  it('throws when deleting non-existent history record', () => {
    expect(() => store.deleteHistoryRecord('nonexistent')).toThrow('not found');
  });
});

describe('BackupJobsStore — Job execution tracking', () => {
  it('marks a job as running', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    store.markJobRunning(job.id);
    const updated = store.getJob(job.id);
    expect(updated?.lastStatus).toBe('running');
    expect(updated?.lastRunAt).toBeTruthy();
  });

  it('marks a job as completed', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    store.markJobCompleted(job.id, { objectPath: 'test/path.sql.gz' });
    const updated = store.getJob(job.id);
    expect(updated?.lastStatus).toBe('success');
    expect(updated?.lastBackupPath).toBe('test/path.sql.gz');
  });

  it('marks a job as failed', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    store.markJobFailed(job.id, 'pg_dump failed');
    const updated = store.getJob(job.id);
    expect(updated?.lastStatus).toBe('failed');
    expect(updated?.lastError).toBe('pg_dump failed');
  });
});

describe('BackupJobsStore — Persistence', () => {
  it('persists jobs and history across reloads', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'persist_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
    });

    store.addHistoryRecord({
      id: 'persist-rec',
      jobId: job.id,
      scope: 'database',
      databaseName: 'persist_db',
      bucket: 'b',
      objectPath: 'p',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 100,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    // Create a new store instance at the same path
    const store2 = new BackupJobsStore(tmpDir);
    store2.init();

    expect(store2.listJobs()).toHaveLength(1);
    expect(store2.listJobs()[0]!.databaseName).toBe('persist_db');
    expect(store2.listHistory()).toHaveLength(1);
    expect(store2.listHistory()[0]!.id).toBe('persist-rec');
  });
});
