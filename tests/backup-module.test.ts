import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const { mockTestGcsConnection, mockRunDatabaseBackupToGcs } = vi.hoisted(
  () => ({
    mockTestGcsConnection: vi.fn(),
    mockRunDatabaseBackupToGcs: vi.fn(),
  })
);

vi.mock('../src/services/backup-gcs.js', () => ({
  testGcsConnection: mockTestGcsConnection,
}));

vi.mock('../src/services/backup-runner.js', () => ({
  runDatabaseBackupToGcs: mockRunDatabaseBackupToGcs,
}));

vi.mock('../src/services/postgres.js', () => ({
  initPostgres: vi.fn(),
  setPgPool: vi.fn(),
  resetPgPool: vi.fn(),
  getPgPool: vi.fn(),
}));

vi.mock('../src/services/build.js', () => ({
  setBuildsBase: vi.fn(),
  buildFromRepo: vi.fn(),
  clearBuildLog: vi.fn(),
  getBuildLogPath: vi.fn(),
}));

vi.mock('../src/services/traefik.js', () => ({
  initTraefikPaths: vi.fn(),
  setTraefikPaths: vi.fn(),
  resetTraefikPaths: vi.fn(),
  writeRouteConfig: vi.fn(),
  removeRouteConfig: vi.fn(),
  listRouteConfigs: vi.fn().mockResolvedValue([]),
  getCertificates: vi.fn().mockResolvedValue([]),
  getCertificateForDomain: vi.fn().mockResolvedValue(null),
}));

import { buildApp } from '../src/app.js';
import { setPgPool, resetPgPool } from '../src/services/postgres.js';
import type { AgentConfig } from '../src/config.js';

const AUTH_TOKEN = 'test-backup-token';
const HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-backup-routes-'));
  setPgPool({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Pool);

  const config: AgentConfig = {
    port: 0,
    host: '127.0.0.1',
    authToken: AUTH_TOKEN,
    version: '1.0.0-test',
    statePath: tmpDir,
    logLevel: 'error',
    rateLimitMax: 1000,
    postgres: { host: 'localhost', port: 5432, user: 'platform', password: '' },
  };

  app = await buildApp(config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetPgPool();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockTestGcsConnection.mockReset();
  mockRunDatabaseBackupToGcs.mockReset();
});

describe('POST /api/backup/gcs/test', () => {
  it('requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/gcs/test',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when credentialsJson is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/gcs/test',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { bucket: 'platform-storage' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('credentialsJson');
  });

  it('returns 400 when bucket is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/gcs/test',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { credentialsJson: '{}' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('bucket');
  });

  it('returns the GCS test result on success', async () => {
    mockTestGcsConnection.mockResolvedValue({
      success: true,
      message: 'Connection successful',
      testedAt: '2026-04-15T21:00:00.000Z',
      objectPath: 'platform-backups/_platform_manager_test/test.txt',
      projectId: 'platform-storage-493501',
    });

    const payload = {
      credentialsJson: '{"type":"service_account"}',
      bucket: 'platform-storage',
      prefix: 'platform-backups',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/gcs/test',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(mockTestGcsConnection).toHaveBeenCalledWith(payload);
  });

  it('returns 500 when the provider test fails', async () => {
    mockTestGcsConnection.mockRejectedValue(new Error('Permission denied'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/gcs/test',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        credentialsJson: '{"type":"service_account"}',
        bucket: 'platform-storage',
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('Permission denied');
  });
});

describe('POST /api/backup/run', () => {
  it('returns 400 when database is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/run',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        credentialsJson: '{"type":"service_account"}',
        bucket: 'platform-storage',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('database');
  });

  it('returns the backup result on success', async () => {
    mockRunDatabaseBackupToGcs.mockResolvedValue({
      success: true,
      bucket: 'platform-storage',
      objectPath: 'platform-backups/databases/app_db/2026/04/15/test.sql.gz',
      database: 'app_db',
      compressed: true,
      sizeBytes: 1234,
      checksumSha256: 'abc123',
      projectId: 'platform-storage-493501',
      startedAt: '2026-04-15T21:00:00.000Z',
      endedAt: '2026-04-15T21:00:01.000Z',
      durationMs: 1000,
    });

    const payload = {
      credentialsJson: '{"type":"service_account"}',
      bucket: 'platform-storage',
      prefix: 'platform-backups',
      database: 'app_db',
      compression: true,
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/run',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().database).toBe('app_db');
    expect(mockRunDatabaseBackupToGcs).toHaveBeenCalledOnce();
  });

  it('returns 500 when the backup runner fails', async () => {
    mockRunDatabaseBackupToGcs.mockRejectedValue(new Error('pg_dump failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/run',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        credentialsJson: '{"type":"service_account"}',
        bucket: 'platform-storage',
        database: 'app_db',
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('pg_dump failed');
  });
});
