// ── Backup GCS Service ─────────────────────────────────────────────────────
//
// Reusable Google Cloud Storage helpers for backup upload/download flows.

import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { Storage } from '@google-cloud/storage';

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

export interface ParsedGcsCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface TestGcsConnectionInput {
  credentialsJson: string;
  bucket: string;
  prefix?: string;
}

export interface TestGcsConnectionResult {
  success: boolean;
  message: string;
  testedAt: string;
  objectPath: string;
  projectId: string;
}

export interface UploadToGcsInput {
  credentialsJson: string;
  bucket: string;
  objectPath: string;
  content: string | Buffer;
  contentType?: string;
}

export interface UploadToGcsResult {
  bucket: string;
  objectPath: string;
  projectId: string;
}

export interface DownloadFromGcsInput {
  credentialsJson: string;
  bucket: string;
  objectPath: string;
  destinationPath: string;
}

export interface CreateGcsWriteStreamInput {
  credentialsJson: string;
  bucket: string;
  objectPath: string;
  contentType?: string;
}

export interface CreateGcsWriteStreamResult {
  bucket: string;
  objectPath: string;
  projectId: string;
  writeStream: Writable;
}

export function parseGcsCredentials(
  credentialsJson: string
): ParsedGcsCredentials {
  let parsed: ServiceAccountCredentials;

  try {
    parsed = JSON.parse(credentialsJson) as ServiceAccountCredentials;
  } catch {
    throw new Error(
      'Invalid JSON file: could not parse service account credentials'
    );
  }

  if (parsed.type !== 'service_account') {
    throw new Error(
      'Invalid credentials: expected a Google service account JSON file'
    );
  }

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      'Invalid credentials: missing project_id, client_email, or private_key'
    );
  }

  if (!parsed.client_email.includes('@')) {
    throw new Error('Invalid credentials: malformed client_email');
  }

  if (!parsed.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Invalid credentials: malformed private_key');
  }

  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  };
}

function normalizeBucketName(bucket: string): string {
  const clean = bucket.trim();
  if (!clean) throw new Error('Bucket name is required');
  if (!/^[a-z0-9._-]+$/.test(clean)) {
    throw new Error('Bucket name contains invalid characters');
  }
  return clean;
}

function normalizeObjectPath(objectPath: string): string {
  const clean = objectPath.trim().replace(/^\/+/, '');
  if (!clean) throw new Error('Object path is required');
  return clean;
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return '';
  return prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function createStorageClient(credentialsJson: string): {
  storage: Storage;
  credentials: ParsedGcsCredentials;
} {
  const credentials = parseGcsCredentials(credentialsJson);

  const storage = new Storage({
    projectId: credentials.projectId,
    credentials: {
      client_email: credentials.clientEmail,
      private_key: credentials.privateKey,
    },
  });

  return { storage, credentials };
}

function formatGcsErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [];
    if (err.message) parts.push(err.message);

    const withCause = err as Error & {
      code?: string;
      errno?: string | number;
      syscall?: string;
      hostname?: string;
      cause?: unknown;
    };

    if (withCause.code) parts.push(`code=${withCause.code}`);
    if (withCause.errno !== undefined)
      parts.push(`errno=${String(withCause.errno)}`);
    if (withCause.syscall) parts.push(`syscall=${withCause.syscall}`);
    if (withCause.hostname) parts.push(`hostname=${withCause.hostname}`);

    if (withCause.cause && typeof withCause.cause === 'object') {
      const cause = withCause.cause as {
        message?: string;
        code?: string;
        errno?: string | number;
      };
      if (cause.message) parts.push(`cause=${cause.message}`);
      if (cause.code) parts.push(`causeCode=${cause.code}`);
      if (cause.errno !== undefined)
        parts.push(`causeErrno=${String(cause.errno)}`);
    }

    if (parts.length > 0) return parts.join(' | ');
  }

  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return 'Unknown GCS error';
}

export async function testGcsConnection(
  input: TestGcsConnectionInput
): Promise<TestGcsConnectionResult> {
  const bucketName = normalizeBucketName(input.bucket);
  const prefix = normalizePrefix(input.prefix);
  const { storage, credentials } = createStorageClient(input.credentialsJson);

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const objectPath = [
    prefix,
    '_platform_manager_test',
    `${timestamp}-${randomUUID()}.txt`,
  ]
    .filter(Boolean)
    .join('/');

  const file = storage.bucket(bucketName).file(objectPath);

  try {
    await file.save(`platform-agent test ${now.toISOString()}`, {
      contentType: 'text/plain',
      resumable: false,
      validation: false,
    });

    await file.delete();

    return {
      success: true,
      message: `Connection successful. Test object written and deleted in gs://${bucketName}`,
      testedAt: now.toISOString(),
      objectPath,
      projectId: credentials.projectId,
    };
  } catch (err) {
    const message = formatGcsErrorMessage(err);
    throw new Error(
      [
        'GCS connection test failed.',
        `Service account: ${credentials.clientEmail}`,
        `Project: ${credentials.projectId}`,
        `Bucket: ${bucketName}`,
        `Object: ${objectPath}`,
        'Operation: upload test object then delete it',
        `Provider error: ${message}`,
      ].join(' ')
    );
  }
}

export async function uploadToGcs(
  input: UploadToGcsInput
): Promise<UploadToGcsResult> {
  const bucketName = normalizeBucketName(input.bucket);
  const objectPath = normalizeObjectPath(input.objectPath);
  const { storage, credentials } = createStorageClient(input.credentialsJson);

  try {
    await storage
      .bucket(bucketName)
      .file(objectPath)
      .save(input.content, {
        contentType: input.contentType ?? 'application/octet-stream',
        resumable: false,
        validation: false,
      });

    return {
      bucket: bucketName,
      objectPath,
      projectId: credentials.projectId,
    };
  } catch (err) {
    throw new Error(`GCS upload failed: ${formatGcsErrorMessage(err)}`);
  }
}

export function createGcsWriteStream(
  input: CreateGcsWriteStreamInput
): CreateGcsWriteStreamResult {
  const bucketName = normalizeBucketName(input.bucket);
  const objectPath = normalizeObjectPath(input.objectPath);
  const { storage, credentials } = createStorageClient(input.credentialsJson);

  return {
    bucket: bucketName,
    objectPath,
    projectId: credentials.projectId,
    writeStream: storage
      .bucket(bucketName)
      .file(objectPath)
      .createWriteStream({
        resumable: false,
        validation: false,
        metadata: {
          contentType: input.contentType ?? 'application/octet-stream',
        },
      }),
  };
}

export async function downloadFromGcs(
  input: DownloadFromGcsInput
): Promise<void> {
  const bucketName = normalizeBucketName(input.bucket);
  const objectPath = normalizeObjectPath(input.objectPath);
  const { storage } = createStorageClient(input.credentialsJson);

  try {
    await storage.bucket(bucketName).file(objectPath).download({
      destination: input.destinationPath,
    });
  } catch (err) {
    throw new Error(`GCS download failed: ${formatGcsErrorMessage(err)}`);
  }
}

export async function deleteFromGcs(
  credentialsJson: string,
  bucket: string,
  objectPath: string
): Promise<void> {
  const bucketName = normalizeBucketName(bucket);
  const normalizedPath = normalizeObjectPath(objectPath);
  const { storage } = createStorageClient(credentialsJson);

  try {
    await storage.bucket(bucketName).file(normalizedPath).delete();
  } catch (err) {
    throw new Error(`GCS delete failed: ${formatGcsErrorMessage(err)}`);
  }
}
