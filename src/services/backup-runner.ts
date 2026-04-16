// ── Backup Runner ──────────────────────────────────────────────────────────
//
// Executes PostgreSQL dumps from the shared platform-postgres container and
// streams them directly to Google Cloud Storage.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { AgentConfig } from '../config.js';
import { createGcsWriteStream } from './backup-gcs.js';

const DATABASE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const POSTGRES_CONTAINER = 'platform-postgres';

export interface RunDatabaseBackupInput {
  credentialsJson: string;
  bucket: string;
  prefix?: string;
  database: string;
  compression?: boolean;
}

export interface DatabaseBackupResult {
  success: boolean;
  bucket: string;
  objectPath: string;
  database: string;
  compressed: boolean;
  sizeBytes: number;
  checksumSha256: string;
  projectId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

function normalizeDatabaseName(database: string): string {
  const clean = database.trim();
  if (!clean) throw new Error('database is required');
  if (!DATABASE_NAME_RE.test(clean)) {
    throw new Error('database name is invalid');
  }
  return clean;
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return '';
  return prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function buildObjectPath(
  prefix: string,
  database: string,
  compression: boolean,
  date: Date
): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}.sql${compression ? '.gz' : ''}`;

  return [prefix, 'databases', database, year, month, day, filename]
    .filter(Boolean)
    .join('/');
}

function waitForProcessExit(child: ReturnType<typeof spawn>): Promise<void> {
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
        resolve();
        return;
      }

      reject(
        new Error(
          `pg_dump failed with exit ${code}: ${stderr.trim() || 'no stderr'}`
        )
      );
    });
  });
}

export async function runDatabaseBackupToGcs(
  config: AgentConfig,
  input: RunDatabaseBackupInput
): Promise<DatabaseBackupResult> {
  const database = normalizeDatabaseName(input.database);
  const compression = input.compression ?? true;
  const now = new Date();
  const startedAt = now.toISOString();
  const prefix = normalizePrefix(input.prefix);
  const objectPath = buildObjectPath(prefix, database, compression, now);

  const dumpProcess = spawn(
    'docker',
    [
      'exec',
      POSTGRES_CONTAINER,
      'pg_dump',
      '-U',
      config.postgres.user,
      database,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }
  );

  if (!dumpProcess.stdout) {
    throw new Error('pg_dump stdout stream is unavailable');
  }

  const { writeStream, bucket, projectId } = createGcsWriteStream({
    credentialsJson: input.credentialsJson,
    bucket: input.bucket,
    objectPath,
    contentType: compression ? 'application/gzip' : 'application/sql',
  });

  let sizeBytes = 0;
  const sha256 = createHash('sha256');
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      sha256.update(buffer);
      callback(null, buffer);
    },
  });

  try {
    if (compression) {
      await Promise.all([
        pipeline(dumpProcess.stdout, createGzip(), counter, writeStream),
        waitForProcessExit(dumpProcess),
      ]);
    } else {
      await Promise.all([
        pipeline(dumpProcess.stdout, counter, writeStream),
        waitForProcessExit(dumpProcess),
      ]);
    }
  } catch (err) {
    dumpProcess.kill('SIGTERM');
    throw err;
  }

  const endedAt = new Date().toISOString();

  return {
    success: true,
    bucket,
    objectPath,
    database,
    compressed: compression,
    sizeBytes,
    checksumSha256: sha256.digest('hex'),
    projectId,
    startedAt,
    endedAt,
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
  };
}
