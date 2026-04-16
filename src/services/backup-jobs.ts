// ── Backup Jobs Store ──────────────────────────────────────────────────────
//
// Persists backup job configurations and execution history to disk.
// File layout:
//   <statePath>/backups/
//     jobs.json     — array of BackupJob
//     history.json  — array of BackupRecord (last 500)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types (mirrored from shared — agent is standalone) ─────────────────────

export type BackupStatus = 'pending' | 'running' | 'success' | 'failed';
export type BackupFrequency = 'daily' | 'weekly' | 'cron';
export type BackupScope = 'instance' | 'database';

export interface BackupJob {
  id: string;
  enabled: boolean;
  scope: BackupScope;
  databaseName?: string;
  frequency: BackupFrequency;
  hourUtc: number;
  minuteUtc: number;
  weekDayUtc?: number;
  cronExpr?: string;
  retentionDays: number;
  bucket?: string;
  prefix?: string;
  compression: boolean;
  lastRunAt?: string;
  lastStatus?: BackupStatus;
  lastError?: string;
  lastBackupPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRecord {
  id: string;
  jobId?: string;
  scope: BackupScope;
  databaseName?: string;
  bucket: string;
  objectPath: string;
  checksumSha256: string;
  compressed: boolean;
  sizeBytes: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: BackupStatus;
  error?: string;
  trigger: 'manual' | 'scheduled';
}

export interface BackupJobCreateInput {
  scope: BackupScope;
  databaseName?: string;
  frequency: BackupFrequency;
  hourUtc: number;
  minuteUtc: number;
  weekDayUtc?: number;
  cronExpr?: string;
  retentionDays?: number;
  bucket?: string;
  prefix?: string;
  compression?: boolean;
}

export interface BackupJobUpdateInput {
  enabled?: boolean;
  frequency?: BackupFrequency;
  hourUtc?: number;
  minuteUtc?: number;
  weekDayUtc?: number;
  cronExpr?: string;
  retentionDays?: number;
  bucket?: string;
  prefix?: string;
  compression?: boolean;
}

const MAX_HISTORY = 500;
const DATABASE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// ── BackupJobsStore ────────────────────────────────────────────────────────

export class BackupJobsStore {
  private readonly dir: string;
  private readonly jobsPath: string;
  private readonly historyPath: string;
  private jobs: BackupJob[] = [];
  private history: BackupRecord[] = [];

  constructor(statePath: string) {
    this.dir = join(statePath, 'backups');
    this.jobsPath = join(this.dir, 'jobs.json');
    this.historyPath = join(this.dir, 'history.json');
  }

  // ── Init ───────────────────────────────────────────────────────────────

  init(): void {
    mkdirSync(this.dir, { recursive: true });
    this.jobs = this.loadJson(this.jobsPath, []);
    this.history = this.loadJson(this.historyPath, []);
  }

  // ── Jobs CRUD ──────────────────────────────────────────────────────────

  listJobs(): BackupJob[] {
    return [...this.jobs];
  }

  getJob(id: string): BackupJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  createJob(input: BackupJobCreateInput): BackupJob {
    this.validateJobInput(input);

    const now = new Date().toISOString();
    const job: BackupJob = {
      id: randomUUID(),
      enabled: true,
      scope: input.scope,
      databaseName: input.scope === 'database' ? input.databaseName : undefined,
      frequency: input.frequency,
      hourUtc: input.hourUtc,
      minuteUtc: input.minuteUtc,
      weekDayUtc: input.frequency === 'weekly' ? input.weekDayUtc : undefined,
      cronExpr: input.frequency === 'cron' ? input.cronExpr : undefined,
      retentionDays: input.retentionDays ?? 14,
      bucket: input.bucket,
      prefix: input.prefix,
      compression: input.compression ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.push(job);
    this.persistJobs();
    return job;
  }

  updateJob(id: string, updates: BackupJobUpdateInput): BackupJob {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Backup job not found: ${id}`);

    const job = this.jobs[idx]!;

    if (updates.frequency !== undefined) job.frequency = updates.frequency;
    if (updates.hourUtc !== undefined) job.hourUtc = updates.hourUtc;
    if (updates.minuteUtc !== undefined) job.minuteUtc = updates.minuteUtc;
    if (updates.weekDayUtc !== undefined) job.weekDayUtc = updates.weekDayUtc;
    if (updates.cronExpr !== undefined) job.cronExpr = updates.cronExpr;
    if (updates.retentionDays !== undefined) job.retentionDays = updates.retentionDays;
    if (updates.bucket !== undefined) job.bucket = updates.bucket;
    if (updates.prefix !== undefined) job.prefix = updates.prefix;
    if (updates.compression !== undefined) job.compression = updates.compression;
    if (updates.enabled !== undefined) job.enabled = updates.enabled;

    job.updatedAt = new Date().toISOString();
    this.jobs[idx] = job;
    this.persistJobs();
    return job;
  }

  deleteJob(id: string): void {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Backup job not found: ${id}`);
    this.jobs.splice(idx, 1);
    this.persistJobs();
  }

  toggleJob(id: string, enabled: boolean): BackupJob {
    return this.updateJob(id, { enabled });
  }

  // ── Job execution tracking ─────────────────────────────────────────────

  markJobRunning(id: string): void {
    const job = this.getJob(id);
    if (!job) return;
    job.lastRunAt = new Date().toISOString();
    job.lastStatus = 'running';
    job.lastError = undefined;
    this.persistJobs();
  }

  markJobCompleted(id: string, result: { objectPath: string }): void {
    const job = this.getJob(id);
    if (!job) return;
    job.lastStatus = 'success';
    job.lastBackupPath = result.objectPath;
    job.lastError = undefined;
    job.updatedAt = new Date().toISOString();
    this.persistJobs();
  }

  markJobFailed(id: string, error: string): void {
    const job = this.getJob(id);
    if (!job) return;
    job.lastStatus = 'failed';
    job.lastError = error;
    job.updatedAt = new Date().toISOString();
    this.persistJobs();
  }

  // ── History ────────────────────────────────────────────────────────────

  listHistory(opts?: { limit?: number; database?: string }): BackupRecord[] {
    let records = [...this.history];
    if (opts?.database) {
      records = records.filter((r) => r.databaseName === opts.database);
    }
    records.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    if (opts?.limit) {
      records = records.slice(0, opts.limit);
    }
    return records;
  }

  addHistoryRecord(record: BackupRecord): void {
    this.history.push(record);
    // Trim oldest if over max
    if (this.history.length > MAX_HISTORY) {
      this.history.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      );
      this.history = this.history.slice(0, MAX_HISTORY);
    }
    this.persistHistory();
  }

  deleteHistoryRecord(id: string): void {
    const idx = this.history.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Backup record not found: ${id}`);
    this.history.splice(idx, 1);
    this.persistHistory();
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private validateJobInput(input: BackupJobCreateInput): void {
    if (input.scope === 'database') {
      if (!input.databaseName) {
        throw new Error('databaseName is required when scope is "database"');
      }
      if (!DATABASE_NAME_RE.test(input.databaseName)) {
        throw new Error('databaseName is invalid');
      }
    }

    if (input.hourUtc < 0 || input.hourUtc > 23) {
      throw new Error('hourUtc must be 0-23');
    }
    if (input.minuteUtc < 0 || input.minuteUtc > 59) {
      throw new Error('minuteUtc must be 0-59');
    }

    if (input.frequency === 'weekly') {
      if (input.weekDayUtc === undefined || input.weekDayUtc < 0 || input.weekDayUtc > 6) {
        throw new Error('weekDayUtc (0-6) is required for weekly frequency');
      }
    }

    if (input.frequency === 'cron') {
      if (!input.cronExpr) {
        throw new Error('cronExpr is required for cron frequency');
      }
    }

    if (input.retentionDays !== undefined && input.retentionDays < 1) {
      throw new Error('retentionDays must be >= 1');
    }
  }

  // ── Persistence helpers ────────────────────────────────────────────────

  private persistJobs(): void {
    writeFileSync(this.jobsPath, JSON.stringify(this.jobs, null, 2));
  }

  private persistHistory(): void {
    writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
  }

  private loadJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      return fallback;
    }
  }
}
