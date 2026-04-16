import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig } from '../src/config.js';

// We test the inspectDump logic via the exported restoreDatabaseFromGcs,
// and mock the GCS download / psql execution.

// Build a fake pg_dump SQL content
function buildFakeDump(): string {
  return [
    '-- PostgreSQL database dump',
    '',
    'SET statement_timeout = 0;',
    'SET client_encoding = \'UTF8\';',
    '',
    'CREATE TABLE public.users (',
    '    id integer NOT NULL,',
    '    name text',
    ');',
    '',
    'CREATE TABLE public.posts (',
    '    id integer NOT NULL,',
    '    title text,',
    '    user_id integer',
    ');',
    '',
    'CREATE SEQUENCE public.users_id_seq',
    '    AS integer',
    '    START WITH 1;',
    '',
    'CREATE SEQUENCE public.posts_id_seq',
    '    AS integer',
    '    START WITH 1;',
    '',
    'CREATE VIEW public.active_users AS',
    '    SELECT * FROM public.users;',
    '',
    'CREATE OR REPLACE FUNCTION public.notify_change() RETURNS trigger',
    '    LANGUAGE plpgsql',
    '    AS $$ BEGIN RETURN NEW; END; $$;',
    '',
    'CREATE INDEX idx_posts_user_id ON public.posts USING btree (user_id);',
    'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id);',
    '',
    'CREATE TRIGGER posts_notify AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.notify_change();',
    '',
    'COPY public.users (id, name) FROM stdin;',
    '1\tAlice',
    '2\tBob',
    '\\.',
    '',
    'COPY public.posts (id, title, user_id) FROM stdin;',
    '1\tHello\t1',
    '\\.',
    '',
    '-- PostgreSQL database dump complete',
  ].join('\n');
}

function buildConfig(statePath: string): AgentConfig {
  return {
    port: 3100,
    host: '0.0.0.0',
    authToken: 'test-token',
    version: '1.0.0',
    statePath,
    logLevel: 'error',
    rateLimitMax: 100,
    postgres: {
      host: 'platform-postgres',
      port: 5432,
      user: 'platform',
      password: 'test-password',
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'restore-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// We can't easily test the full restoreDatabaseFromGcs because it calls
// downloadFromGcs and docker exec. Instead, test the inspectDump logic
// by importing the module and mocking GCS download to write a local file.

describe('Restore Runner — dry-run inspection', () => {
  it('parses tables, views, sequences, functions, indexes, triggers, COPY from plain SQL dump', async () => {
    // Write a fake dump file
    const dumpPath = join(tmpDir, 'test-dump.sql');
    writeFileSync(dumpPath, buildFakeDump(), 'utf-8');

    // Mock downloadFromGcs to copy our fake dump instead of hitting GCS
    const gcs = await import('../src/services/backup-gcs.js');
    const downloadSpy = vi
      .spyOn(gcs, 'downloadFromGcs')
      .mockImplementation(async (input) => {
        const { copyFileSync } = await import('node:fs');
        copyFileSync(dumpPath, input.destinationPath);
      });

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    const result = await restoreDatabaseFromGcs(config, {
      credentialsJson: '{}',
      bucket: 'test-bucket',
      objectPath: 'backups/test.sql',
      database: 'test_db',
      compressed: false,
      dryRun: true,
    });

    expect(downloadSpy).toHaveBeenCalledOnce();
    expect(result.dryRun).toBe(true);

    if (!result.dryRun) throw new Error('Expected dry-run result');

    expect(result.database).toBe('test_db');
    expect(result.tables).toEqual(['users', 'posts']);
    expect(result.views).toEqual(['active_users']);
    expect(result.sequences).toEqual(['users_id_seq', 'posts_id_seq']);
    expect(result.functions).toBe(1);
    expect(result.indexes).toBe(2);
    expect(result.triggers).toBe(1);
    expect(result.copyStatements).toBe(2);
    expect(result.fileSizeBytes).toBeGreaterThan(0);
    expect(result.startedAt).toBeTruthy();
    expect(result.endedAt).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parses a compressed dump (gzip)', async () => {
    const { gzipSync } = await import('node:zlib');

    const dumpContent = buildFakeDump();
    const compressed = gzipSync(Buffer.from(dumpContent, 'utf-8'));
    const dumpPath = join(tmpDir, 'test-dump.sql.gz');
    writeFileSync(dumpPath, compressed);

    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockImplementation(async (input) => {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(dumpPath, input.destinationPath);
    });

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    const result = await restoreDatabaseFromGcs(config, {
      credentialsJson: '{}',
      bucket: 'test-bucket',
      objectPath: 'backups/test.sql.gz',
      database: 'test_db',
      compressed: true,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    if (!result.dryRun) throw new Error('Expected dry-run result');

    expect(result.tables).toEqual(['users', 'posts']);
    expect(result.copyStatements).toBe(2);
    expect(result.compressed).toBe(true);
  });

  it('handles empty dump file', async () => {
    const dumpPath = join(tmpDir, 'empty.sql');
    writeFileSync(dumpPath, '-- empty dump\n', 'utf-8');

    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockImplementation(async (input) => {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(dumpPath, input.destinationPath);
    });

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    const result = await restoreDatabaseFromGcs(config, {
      credentialsJson: '{}',
      bucket: 'test-bucket',
      objectPath: 'backups/empty.sql',
      database: 'test_db',
      compressed: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    if (!result.dryRun) throw new Error('Expected dry-run result');

    expect(result.tables).toEqual([]);
    expect(result.views).toEqual([]);
    expect(result.sequences).toEqual([]);
    expect(result.functions).toBe(0);
    expect(result.indexes).toBe(0);
    expect(result.triggers).toBe(0);
    expect(result.copyStatements).toBe(0);
  });
});

describe('Restore Runner — validation', () => {
  it('rejects empty database name', async () => {
    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockImplementation(async () => {});

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    await expect(
      restoreDatabaseFromGcs(config, {
        credentialsJson: '{}',
        bucket: 'test-bucket',
        objectPath: 'backups/test.sql',
        database: '',
        compressed: false,
        dryRun: true,
      })
    ).rejects.toThrow('database is required');
  });

  it('rejects invalid database name', async () => {
    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockImplementation(async () => {});

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    await expect(
      restoreDatabaseFromGcs(config, {
        credentialsJson: '{}',
        bucket: 'test-bucket',
        objectPath: 'backups/test.sql',
        database: 'DROP TABLE--',
        compressed: false,
        dryRun: true,
      })
    ).rejects.toThrow('database name is invalid');
  });
});

describe('Restore Runner — GCS download failure', () => {
  it('propagates GCS download error in dry-run mode', async () => {
    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockRejectedValue(
      new Error('GCS download failed: 404 Not Found')
    );

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    await expect(
      restoreDatabaseFromGcs(config, {
        credentialsJson: '{}',
        bucket: 'test-bucket',
        objectPath: 'backups/missing.sql',
        database: 'test_db',
        compressed: false,
        dryRun: true,
      })
    ).rejects.toThrow('GCS download failed');
  });

  it('returns failed result on GCS download error in real restore', async () => {
    const gcs = await import('../src/services/backup-gcs.js');
    vi.spyOn(gcs, 'downloadFromGcs').mockRejectedValue(
      new Error('GCS download failed: 403 Forbidden')
    );

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    const result = await restoreDatabaseFromGcs(config, {
      credentialsJson: '{}',
      bucket: 'test-bucket',
      objectPath: 'backups/forbidden.sql',
      database: 'test_db',
      compressed: false,
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    if (result.dryRun) throw new Error('Expected real restore result');

    expect(result.success).toBe(false);
    expect(result.error).toContain('GCS download failed');
  });
});

describe('Restore Runner — temp file cleanup', () => {
  it('cleans up temp file after dry-run', async () => {
    const { existsSync } = await import('node:fs');
    const dumpPath = join(tmpDir, 'cleanup-test.sql');
    writeFileSync(dumpPath, buildFakeDump(), 'utf-8');

    const gcs = await import('../src/services/backup-gcs.js');
    let capturedPath = '';
    vi.spyOn(gcs, 'downloadFromGcs').mockImplementation(async (input) => {
      const { copyFileSync } = await import('node:fs');
      capturedPath = input.destinationPath;
      copyFileSync(dumpPath, input.destinationPath);
    });

    const { restoreDatabaseFromGcs } = await import(
      '../src/services/backup-restore-runner.js'
    );

    const config = buildConfig(tmpDir);
    await restoreDatabaseFromGcs(config, {
      credentialsJson: '{}',
      bucket: 'test-bucket',
      objectPath: 'backups/test.sql',
      database: 'test_db',
      compressed: false,
      dryRun: true,
    });

    expect(capturedPath).toBeTruthy();
    expect(existsSync(capturedPath)).toBe(false);
  });
});
