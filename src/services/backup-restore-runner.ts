// ── Backup Restore Runner ──────────────────────────────────────────────────
//
// Downloads a SQL dump from GCS and restores it into a PostgreSQL database
// via `docker exec platform-postgres psql`.
//
// Two modes:
//   - dry-run: downloads the dump, parses it for metadata (tables, sizes),
//     then deletes the temp file.  Nothing is written to the database.
//   - real restore: downloads the dump, pipes it through `psql` inside
//     the postgres container.

import { spawn } from 'node:child_process';
import { createReadStream, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { AgentConfig } from '../config.js';
import { downloadFromGcs } from './backup-gcs.js';

const POSTGRES_CONTAINER = 'platform-postgres';
const DATABASE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// ── Types ──────────────────────────────────────────────────────────────────

export interface RestoreInput {
  credentialsJson: string;
  bucket: string;
  objectPath: string;
  database: string;
  compressed: boolean;
  dryRun: boolean;
}

export interface RestoreDryRunReport {
  dryRun: true;
  database: string;
  bucket: string;
  objectPath: string;
  compressed: boolean;
  fileSizeBytes: number;
  tables: string[];
  views: string[];
  sequences: string[];
  functions: number;
  indexes: number;
  triggers: number;
  copyStatements: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface RestoreReport {
  dryRun: false;
  database: string;
  bucket: string;
  objectPath: string;
  compressed: boolean;
  fileSizeBytes: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  warnings: string[];
}

export type RestoreResult = RestoreDryRunReport | RestoreReport;

// ── Helpers ────────────────────────────────────────────────────────────────

function validateDatabaseName(database: string): string {
  const clean = database.trim();
  if (!clean) throw new Error('database is required');
  if (!DATABASE_NAME_RE.test(clean)) {
    throw new Error('database name is invalid');
  }
  return clean;
}

function waitForProcessExit(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once('error', (err) => {
      reject(err);
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }
      reject(
        new Error(
          `psql failed with exit ${code}: ${stderr.trim() || 'no stderr'}`
        )
      );
    });
  });
}

// ── Dry-run: inspect dump ──────────────────────────────────────────────────

async function inspectDump(
  filePath: string,
  compressed: boolean
): Promise<{
  tables: string[];
  views: string[];
  sequences: string[];
  functions: number;
  indexes: number;
  triggers: number;
  copyStatements: number;
}> {
  const tables: string[] = [];
  const views: string[] = [];
  const sequences: string[] = [];
  let functions = 0;
  let indexes = 0;
  let triggers = 0;
  let copyStatements = 0;

  let inputStream: NodeJS.ReadableStream = createReadStream(filePath);
  if (compressed) {
    const gunzip = createGunzip();
    inputStream = inputStream.pipe(gunzip);
  }

  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();

    // CREATE TABLE (not CREATE TABLE ... AS SELECT which is a materialized view)
    if (
      /^CREATE TABLE\s/i.test(trimmed) &&
      !/\bAS\b/i.test(trimmed)
    ) {
      const match = trimmed.match(
        /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/i
      );
      if (match) {
        const name = match[2]!;
        if (!tables.includes(name)) tables.push(name);
      }
    }

    // CREATE VIEW / CREATE MATERIALIZED VIEW
    if (/^CREATE\s+(?:OR REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s/i.test(trimmed)) {
      const match = trimmed.match(
        /VIEW\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i
      );
      if (match) {
        const name = match[2]!;
        if (!views.includes(name)) views.push(name);
      }
    }

    // CREATE SEQUENCE
    if (/^CREATE SEQUENCE\s/i.test(trimmed)) {
      const match = trimmed.match(
        /CREATE SEQUENCE\s+(?:IF NOT EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/i
      );
      if (match) {
        const name = match[2]!;
        if (!sequences.includes(name)) sequences.push(name);
      }
    }

    // CREATE FUNCTION
    if (/^CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s/i.test(trimmed)) {
      functions++;
    }

    // CREATE INDEX
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(trimmed)) {
      indexes++;
    }

    // CREATE TRIGGER
    if (/^CREATE TRIGGER\s/i.test(trimmed)) {
      triggers++;
    }

    // COPY ... FROM stdin
    if (/^COPY\s+/i.test(trimmed) && /FROM stdin/i.test(trimmed)) {
      copyStatements++;
    }
  }

  return { tables, views, sequences, functions, indexes, triggers, copyStatements };
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function restoreDatabaseFromGcs(
  config: AgentConfig,
  input: RestoreInput
): Promise<RestoreResult> {
  const database = validateDatabaseName(input.database);
  const startedAt = new Date().toISOString();

  // Prepare temp directory
  const tmpDir = join(config.statePath, 'backups', 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const ext = input.compressed ? '.sql.gz' : '.sql';
  const tmpFile = join(tmpDir, `restore-${Date.now()}${ext}`);

  try {
    // Download dump from GCS
    await downloadFromGcs({
      credentialsJson: input.credentialsJson,
      bucket: input.bucket,
      objectPath: input.objectPath,
      destinationPath: tmpFile,
    });

    const fileSizeBytes = statSync(tmpFile).size;

    // ── Dry-run ──
    if (input.dryRun) {
      const inspection = await inspectDump(tmpFile, input.compressed);
      const endedAt = new Date().toISOString();

      return {
        dryRun: true,
        database,
        bucket: input.bucket,
        objectPath: input.objectPath,
        compressed: input.compressed,
        fileSizeBytes,
        ...inspection,
        startedAt,
        endedAt,
        durationMs:
          new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      };
    }

    // ── Real restore ──
    const warnings: string[] = [];

    // Pipe the (possibly compressed) SQL dump into psql via docker exec
    const psqlProcess = spawn(
      'docker',
      [
        'exec',
        '-i', // stdin must be connected
        POSTGRES_CONTAINER,
        'psql',
        '-U',
        config.postgres.user,
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      }
    );

    if (!psqlProcess.stdin) {
      throw new Error('psql stdin stream is unavailable');
    }

    // Collect stdout (notices, etc.)
    let stdout = '';
    psqlProcess.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    // Build the pipeline: file → gunzip? → psql stdin
    const readStream = createReadStream(tmpFile);

    if (input.compressed) {
      const gunzip = createGunzip();
      await Promise.all([
        pipeline(readStream, gunzip, psqlProcess.stdin),
        waitForProcessExit(psqlProcess),
      ]);
    } else {
      await Promise.all([
        pipeline(readStream, psqlProcess.stdin),
        waitForProcessExit(psqlProcess),
      ]);
    }

    // Parse warnings from stdout/stderr
    if (stdout) {
      const lines = stdout.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        if (/NOTICE:|WARNING:/i.test(line)) {
          warnings.push(line.trim());
        }
      }
    }

    const endedAt = new Date().toISOString();

    return {
      dryRun: false,
      database,
      bucket: input.bucket,
      objectPath: input.objectPath,
      compressed: input.compressed,
      fileSizeBytes,
      startedAt,
      endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      success: true,
      warnings,
    };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : 'Restore failed';

    if (input.dryRun) {
      throw err; // dry-run errors are just thrown
    }

    return {
      dryRun: false,
      database,
      bucket: input.bucket,
      objectPath: input.objectPath,
      compressed: input.compressed,
      fileSizeBytes: 0,
      startedAt,
      endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      success: false,
      error: errorMsg,
      warnings: [],
    };
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
