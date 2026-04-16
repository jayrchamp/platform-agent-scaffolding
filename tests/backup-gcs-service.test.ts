import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSave,
  mockDelete,
  mockDownload,
  mockFile,
  mockBucket,
  mockStorageCtor,
} = vi.hoisted(() => {
  const save = vi.fn();
  const del = vi.fn();
  const download = vi.fn();
  const file = vi.fn(() => ({ save, delete: del, download }));
  const bucket = vi.fn(() => ({ file }));
  const storageCtor = vi.fn(() => ({ bucket }));

  return {
    mockSave: save,
    mockDelete: del,
    mockDownload: download,
    mockFile: file,
    mockBucket: bucket,
    mockStorageCtor: storageCtor,
  };
});

vi.mock('@google-cloud/storage', () => ({
  Storage: mockStorageCtor,
}));

import {
  parseGcsCredentials,
  testGcsConnection,
  uploadToGcs,
  downloadFromGcs,
  deleteFromGcs,
} from '../src/services/backup-gcs.js';

const VALID_CREDS = JSON.stringify({
  type: 'service_account',
  project_id: 'platform-storage-493501',
  client_email:
    'platform-storage@platform-storage-493501.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
});

describe('backup-gcs service', () => {
  beforeEach(() => {
    mockStorageCtor.mockClear();
    mockBucket.mockClear();
    mockFile.mockClear();
    mockSave.mockReset();
    mockDelete.mockReset();
    mockDownload.mockReset();
  });

  it('parses valid service account credentials', () => {
    const parsed = parseGcsCredentials(VALID_CREDS);
    expect(parsed.projectId).toBe('platform-storage-493501');
    expect(parsed.clientEmail).toContain('@');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseGcsCredentials('{not-json')).toThrow(/could not parse/i);
  });

  it('tests GCS connection by writing and deleting a test object', async () => {
    mockSave.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);

    const result = await testGcsConnection({
      credentialsJson: VALID_CREDS,
      bucket: 'platform-storage',
      prefix: 'platform-backups',
    });

    expect(result.success).toBe(true);
    expect(result.projectId).toBe('platform-storage-493501');
    expect(result.objectPath).toContain(
      'platform-backups/_platform_manager_test/'
    );
    expect(mockSave).toHaveBeenCalledOnce();
    expect(mockDelete).toHaveBeenCalledOnce();
  });

  it('includes credential and bucket context on provider errors', async () => {
    mockSave.mockRejectedValue(
      new Error("Permission 'storage.objects.create' denied on resource")
    );

    await expect(
      testGcsConnection({
        credentialsJson: VALID_CREDS,
        bucket: 'platform-storage',
        prefix: 'platform-backups',
      })
    ).rejects.toThrow(
      /Service account: platform-storage@platform-storage-493501.iam.gserviceaccount.com/
    );
  });

  it('uploads arbitrary content to GCS', async () => {
    mockSave.mockResolvedValue(undefined);

    const result = await uploadToGcs({
      credentialsJson: VALID_CREDS,
      bucket: 'platform-storage',
      objectPath: 'backups/test.sql.gz',
      content: Buffer.from('hello'),
      contentType: 'application/gzip',
    });

    expect(result.bucket).toBe('platform-storage');
    expect(result.objectPath).toBe('backups/test.sql.gz');
    expect(mockSave).toHaveBeenCalledOnce();
  });

  it('downloads an object to a destination path', async () => {
    mockDownload.mockResolvedValue(undefined);

    await downloadFromGcs({
      credentialsJson: VALID_CREDS,
      bucket: 'platform-storage',
      objectPath: 'backups/test.sql.gz',
      destinationPath: '/tmp/test.sql.gz',
    });

    expect(mockDownload).toHaveBeenCalledWith({
      destination: '/tmp/test.sql.gz',
    });
  });

  it('deletes an object from GCS', async () => {
    mockDelete.mockResolvedValue(undefined);

    await deleteFromGcs(VALID_CREDS, 'platform-storage', 'backups/test.sql.gz');

    expect(mockDelete).toHaveBeenCalledOnce();
  });
});
