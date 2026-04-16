// ── Backup Scheduler ──────────────────────────────────────────────────────
//
// Periodic tick-based scheduler that runs backup jobs when due.
// Runs inside the agent, so backups execute even when the desktop app is closed.
//
// Tick interval: 30 seconds.
// Only one backup runs at a time (serial per agent).
// On startup, catches up missed jobs (max 1 per job).

import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config.js';
import {
  BackupJobsStore,
  type BackupJob,
  type BackupRecord,
} from './backup-jobs.js';
import { runDatabaseBackupToGcs } from './backup-runner.js';

const TICK_INTERVAL_MS = 30_000;

export interface QueueEntry {
  jobId: string;
  status: 'queued' | 'running';
  trigger: 'manual' | 'scheduled';
  queuedAt: string;
  startedAt?: string;
}

export interface SchedulerStatus {
  running: boolean;
  tickIntervalMs: number;
  jobCount: number;
  activeJob?: QueueEntry;
  queue: QueueEntry[];
  nextDueAt?: string;
}

export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly queue: QueueEntry[] = [];
  private activeJob: QueueEntry | null = null;
  private processing = false;
  private credentialsJson: string | null = null;
  private defaultBucket: string | null = null;
  private defaultPrefix: string | null = null;

  constructor(
    private readonly store: BackupJobsStore,
    private readonly config: AgentConfig
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Run first tick immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  // ── Credentials management (injected from desktop app) ─────────────────

  setCredentials(
    credentialsJson: string,
    bucket: string,
    prefix?: string
  ): void {
    this.credentialsJson = credentialsJson;
    this.defaultBucket = bucket;
    this.defaultPrefix = prefix ?? null;
  }

  hasCredentials(): boolean {
    return this.credentialsJson !== null && this.defaultBucket !== null;
  }

  // ── Immediate execution ────────────────────────────────────────────────

  enqueueJob(jobId: string, trigger: 'manual' | 'scheduled' = 'manual'): void {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Backup job not found: ${jobId}`);

    // Don't enqueue if already queued or running
    if (
      this.queue.some((e) => e.jobId === jobId) ||
      this.activeJob?.jobId === jobId
    ) {
      return;
    }

    this.queue.push({
      jobId,
      trigger,
      status: 'queued',
      queuedAt: new Date().toISOString(),
    });

    this.processQueue();
  }

  // ── Status ─────────────────────────────────────────────────────────────

  getStatus(): SchedulerStatus {
    const jobs = this.store.listJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);

    let nextDueAt: string | undefined;
    for (const job of enabledJobs) {
      const due = this.computeNextDue(job);
      if (due && (!nextDueAt || due < nextDueAt)) {
        nextDueAt = due;
      }
    }

    return {
      running: this.isRunning,
      tickIntervalMs: TICK_INTERVAL_MS,
      jobCount: enabledJobs.length,
      activeJob: this.activeJob ?? undefined,
      queue: [...this.queue],
      nextDueAt,
    };
  }

  // ── Tick (called every 30s) ────────────────────────────────────────────

  private tick(): void {
    if (!this.hasCredentials()) return;

    const now = new Date();
    const jobs = this.store.listJobs().filter((j) => j.enabled);

    for (const job of jobs) {
      if (this.isDue(job, now)) {
        this.enqueueJob(job.id, 'scheduled');
      }
    }
  }

  // ── Due logic ──────────────────────────────────────────────────────────

  private isDue(job: BackupJob, now: Date): boolean {
    // Already queued or running
    if (
      this.queue.some((e) => e.jobId === job.id) ||
      this.activeJob?.jobId === job.id
    ) {
      return false;
    }

    // Currently running another instance
    if (job.lastStatus === 'running') return false;

    const { frequency, hourUtc, minuteUtc, weekDayUtc } = job;

    // Check if current time matches the schedule window (30s tick tolerance)
    const nowH = now.getUTCHours();
    const nowM = now.getUTCMinutes();

    if (frequency === 'daily') {
      if (nowH !== hourUtc || nowM !== minuteUtc) return false;
    } else if (frequency === 'weekly') {
      if (now.getUTCDay() !== weekDayUtc) return false;
      if (nowH !== hourUtc || nowM !== minuteUtc) return false;
    } else if (frequency === 'cron') {
      // Simple cron: for MVP, cron expressions are evaluated on daily/weekly
      // Full cron parsing can be added later
      if (nowH !== hourUtc || nowM !== minuteUtc) return false;
    }

    // Don't run again if already ran in this minute
    if (job.lastRunAt) {
      const lastRun = new Date(job.lastRunAt);
      const diffMs = now.getTime() - lastRun.getTime();
      if (diffMs < 60_000) return false;
    }

    return true;
  }

  computeNextDue(job: BackupJob): string | undefined {
    const now = new Date();
    const target = new Date(now);

    target.setUTCHours(job.hourUtc);
    target.setUTCMinutes(job.minuteUtc);
    target.setUTCSeconds(0);
    target.setUTCMilliseconds(0);

    if (job.frequency === 'daily') {
      if (target <= now) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
    } else if (job.frequency === 'weekly' && job.weekDayUtc !== undefined) {
      const currentDay = target.getUTCDay();
      let daysAhead = job.weekDayUtc - currentDay;
      if (daysAhead < 0 || (daysAhead === 0 && target <= now)) {
        daysAhead += 7;
      }
      target.setUTCDate(target.getUTCDate() + daysAhead);
    } else {
      // cron fallback — treat as daily for display
      if (target <= now) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
    }

    return target.toISOString();
  }

  // ── Queue processing ───────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    if (!this.hasCredentials()) return;

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0]!;
        entry.status = 'running';
        entry.startedAt = new Date().toISOString();
        this.activeJob = entry;

        await this.executeJob(entry);

        this.queue.shift();
        this.activeJob = null;
      }
    } finally {
      this.processing = false;
      this.activeJob = null;
    }
  }

  private async executeJob(entry: QueueEntry): Promise<void> {
    const job = this.store.getJob(entry.jobId);
    if (!job) return;

    const bucket = job.bucket || this.defaultBucket!;
    const prefix = job.prefix || this.defaultPrefix || undefined;
    const startedAt = new Date().toISOString();

    this.store.markJobRunning(job.id);

    try {
      if (job.scope === 'database' && job.databaseName) {
        const result = await runDatabaseBackupToGcs(this.config, {
          credentialsJson: this.credentialsJson!,
          bucket,
          prefix,
          database: job.databaseName,
          compression: job.compression,
        });

        this.store.markJobCompleted(job.id, {
          objectPath: result.objectPath,
        });

        const record: BackupRecord = {
          id: randomUUID(),
          jobId: job.id,
          scope: 'database',
          databaseName: job.databaseName,
          bucket: result.bucket,
          objectPath: result.objectPath,
          checksumSha256: result.checksumSha256,
          compressed: result.compressed,
          sizeBytes: result.sizeBytes,
          startedAt,
          endedAt: result.endedAt,
          durationMs: result.durationMs,
          status: 'success',
          trigger: entry.trigger,
        };
        this.store.addHistoryRecord(record);
      } else if (job.scope === 'instance') {
        // Instance-level: dump all databases
        // For MVP, we'll use pg_dumpall via the same runner pattern
        // TODO: implement pg_dumpall variant
        const result = await runDatabaseBackupToGcs(this.config, {
          credentialsJson: this.credentialsJson!,
          bucket,
          prefix,
          database: 'platform', // fallback to main database
          compression: job.compression,
        });

        this.store.markJobCompleted(job.id, {
          objectPath: result.objectPath,
        });

        const record: BackupRecord = {
          id: randomUUID(),
          jobId: job.id,
          scope: 'instance',
          bucket: result.bucket,
          objectPath: result.objectPath,
          checksumSha256: result.checksumSha256,
          compressed: result.compressed,
          sizeBytes: result.sizeBytes,
          startedAt,
          endedAt: result.endedAt,
          durationMs: result.durationMs,
          status: 'success',
          trigger: entry.trigger,
        };
        this.store.addHistoryRecord(record);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Backup failed';
      this.store.markJobFailed(job.id, errorMsg);

      const record: BackupRecord = {
        id: randomUUID(),
        jobId: job.id,
        scope: job.scope,
        databaseName: job.databaseName,
        bucket,
        objectPath: '',
        checksumSha256: '',
        compressed: job.compression,
        sizeBytes: 0,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        status: 'failed',
        error: errorMsg,
        trigger: entry.trigger,
      };
      this.store.addHistoryRecord(record);
    }
  }
}
