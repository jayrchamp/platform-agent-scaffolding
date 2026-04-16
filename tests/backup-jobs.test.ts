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

describe('BackupJobsStore — Retention', () => {
  it('returns no expired records when none exist', () => {
    expect(store.getExpiredRecords()).toEqual([]);
  });

  it('returns no expired records for fresh backups', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
      retentionDays: 7,
    });

    store.addHistoryRecord({
      id: 'fresh-rec',
      jobId: job.id,
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'b',
      objectPath: 'p/fresh.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 1000,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 5000,
      status: 'success',
      trigger: 'scheduled',
    });

    expect(store.getExpiredRecords()).toEqual([]);
  });

  it('returns expired records older than retentionDays', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
      retentionDays: 2,
    });

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();

    store.addHistoryRecord({
      id: 'old-rec',
      jobId: job.id,
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'b',
      objectPath: 'p/old.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 2000,
      startedAt: threeDaysAgo,
      endedAt: threeDaysAgo,
      durationMs: 5000,
      status: 'success',
      trigger: 'scheduled',
    });

    const expired = store.getExpiredRecords();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe('old-rec');
  });

  it('does not expire manual backups (no jobId)', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    store.addHistoryRecord({
      id: 'manual-rec',
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'b',
      objectPath: 'p/manual.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 1500,
      startedAt: thirtyDaysAgo,
      endedAt: thirtyDaysAgo,
      durationMs: 5000,
      status: 'success',
      trigger: 'manual',
    });

    expect(store.getExpiredRecords()).toEqual([]);
  });

  it('does not expire failed backups', () => {
    const job = store.createJob({
      scope: 'database',
      databaseName: 'app_db',
      frequency: 'daily',
      hourUtc: 3,
      minuteUtc: 0,
      retentionDays: 1,
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

    store.addHistoryRecord({
      id: 'failed-rec',
      jobId: job.id,
      scope: 'database',
      databaseName: 'app_db',
      bucket: 'b',
      objectPath: '',
      checksumSha256: '',
      compressed: true,
      sizeBytes: 0,
      startedAt: twoDaysAgo,
      endedAt: twoDaysAgo,
      durationMs: 5000,
      status: 'failed',
      error: 'test error',
      trigger: 'scheduled',
    });

    expect(store.getExpiredRecords()).toEqual([]);
  });

  it('deleteHistoryRecords removes multiple records in one call', () => {
    for (let i = 0; i < 5; i++) {
      store.addHistoryRecord({
        id: `batch-${i}`,
        scope: 'database',
        databaseName: 'app_db',
        bucket: 'b',
        objectPath: `p/${i}`,
        checksumSha256: `c${i}`,
        compressed: true,
        sizeBytes: 100,
        startedAt: '2026-04-15T01:00:00Z',
        endedAt: '2026-04-15T01:00:10Z',
        durationMs: 10000,
        status: 'success',
        trigger: 'scheduled',
      });
    }

    expect(store.listHistory()).toHaveLength(5);
    store.deleteHistoryRecords(['batch-0', 'batch-2', 'batch-4']);
    expect(store.listHistory()).toHaveLength(2);
    expect(
      store
        .listHistory()
        .map((r) => r.id)
        .sort()
    ).toEqual(['batch-1', 'batch-3']);
  });
});

describe('BackupJobsStore — Storage Metrics', () => {
  it('returns zero metrics when no history exists', () => {
    const metrics = store.computeStorageMetrics();
    expect(metrics.totalBackups).toBe(0);
    expect(metrics.totalSizeBytes).toBe(0);
    expect(metrics.byDatabase).toEqual({});
  });

  it('computes metrics across multiple databases', () => {
    store.addHistoryRecord({
      id: 'met-1',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: 'p/db1-1.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 1000,
      startedAt: '2026-04-14T01:00:00Z',
      endedAt: '2026-04-14T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    store.addHistoryRecord({
      id: 'met-2',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: 'p/db1-2.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 1500,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    store.addHistoryRecord({
      id: 'met-3',
      scope: 'database',
      databaseName: 'db2',
      bucket: 'b',
      objectPath: 'p/db2-1.sql.gz',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 2000,
      startedAt: '2026-04-15T02:00:00Z',
      endedAt: '2026-04-15T02:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'manual',
    });

    const metrics = store.computeStorageMetrics();
    expect(metrics.totalBackups).toBe(3);
    expect(metrics.totalSizeBytes).toBe(4500);
    expect(metrics.byDatabase['db1']!.count).toBe(2);
    expect(metrics.byDatabase['db1']!.sizeBytes).toBe(2500);
    expect(metrics.byDatabase['db2']!.count).toBe(1);
    expect(metrics.byDatabase['db2']!.sizeBytes).toBe(2000);
  });

  it('ignores failed backups in metrics', () => {
    store.addHistoryRecord({
      id: 'met-fail',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: '',
      checksumSha256: '',
      compressed: true,
      sizeBytes: 0,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'failed',
      error: 'test error',
      trigger: 'scheduled',
    });

    const metrics = store.computeStorageMetrics();
    expect(metrics.totalBackups).toBe(0);
    expect(metrics.totalSizeBytes).toBe(0);
  });

  it('tracks oldest and newest dates per database', () => {
    store.addHistoryRecord({
      id: 'date-1',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: 'p/1',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 100,
      startedAt: '2026-04-10T01:00:00Z',
      endedAt: '2026-04-10T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    store.addHistoryRecord({
      id: 'date-2',
      scope: 'database',
      databaseName: 'db1',
      bucket: 'b',
      objectPath: 'p/2',
      checksumSha256: 'c',
      compressed: true,
      sizeBytes: 200,
      startedAt: '2026-04-15T01:00:00Z',
      endedAt: '2026-04-15T01:00:10Z',
      durationMs: 10000,
      status: 'success',
      trigger: 'scheduled',
    });

    const metrics = store.computeStorageMetrics();
    const db1 = metrics.byDatabase['db1']!;
    expect(db1.oldestAt).toBe('2026-04-10T01:00:10Z');
    expect(db1.newestAt).toBe('2026-04-15T01:00:10Z');
  });
});
