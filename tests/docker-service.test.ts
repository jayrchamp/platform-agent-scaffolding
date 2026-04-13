// ── Docker Service Tests ────────────────────────────────────────────────────
//
// Mocks Dockerode since there's no Docker socket in the test environment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Docker from 'dockerode';
import {
  listContainers,
  listImages,
  listVolumes,
  pingDocker,
  setDockerClient,
  resetDockerClient,
} from '../src/services/docker.js';

// ── Mock Docker client ─────────────────────────────────────────────────────

function createMockDocker(overrides: Partial<Docker> = {}): Docker {
  return {
    listContainers: vi.fn().mockResolvedValue([
      {
        Id: 'abc123def456789012345678',
        Names: ['/platform-postgres'],
        Image: 'postgres:16',
        State: 'running',
        Status: 'Up 3 hours',
        Created: Math.floor(Date.now() / 1000) - 10800,
        Ports: [{ PrivatePort: 5432, PublicPort: 5432, IP: '127.0.0.1', Type: 'tcp' }],
        Labels: { 'com.platform': 'true' },
        NetworkSettings: { Networks: { 'platform-net': {} } },
      },
      {
        Id: 'def456abc789012345678901',
        Names: ['/traefik'],
        Image: 'traefik:v3.0',
        State: 'running',
        Status: 'Up 3 hours',
        Created: Math.floor(Date.now() / 1000) - 10800,
        Ports: [
          { PrivatePort: 80, PublicPort: 80, IP: '0.0.0.0', Type: 'tcp' },
          { PrivatePort: 443, PublicPort: 443, IP: '0.0.0.0', Type: 'tcp' },
        ],
        Labels: {},
        NetworkSettings: { Networks: { 'platform-net': {} } },
      },
    ]),
    listImages: vi.fn().mockResolvedValue([
      {
        Id: 'sha256:aabbccdd11223344',
        RepoTags: ['postgres:16'],
        Size: 400 * 1024 * 1024,
        Created: Math.floor(Date.now() / 1000) - 86400,
      },
    ]),
    listVolumes: vi.fn().mockResolvedValue({
      Volumes: [
        {
          Name: 'platform-pgdata',
          Driver: 'local',
          Mountpoint: '/var/lib/docker/volumes/platform-pgdata/_data',
          CreatedAt: '2026-04-10T10:00:00Z',
          Labels: { 'com.platform': 'true' },
        },
      ],
    }),
    ping: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Docker;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('listContainers', () => {
  let mockDocker: Docker;

  beforeEach(() => {
    mockDocker = createMockDocker();
    setDockerClient(mockDocker);
  });

  afterEach(() => {
    resetDockerClient();
  });

  it('returns mapped container info', async () => {
    const containers = await listContainers();

    expect(containers).toHaveLength(2);
    expect(containers[0]!.name).toBe('platform-postgres');
    expect(containers[0]!.image).toBe('postgres:16');
    expect(containers[0]!.state).toBe('running');
    expect(containers[0]!.id).toHaveLength(12);
    expect(containers[0]!.ports).toHaveLength(1);
    expect(containers[0]!.ports[0]!.containerPort).toBe(5432);
    expect(containers[0]!.networkMode).toBe('platform-net');
  });

  it('strips leading / from container names', async () => {
    const containers = await listContainers();
    expect(containers[0]!.name).not.toMatch(/^\//);
  });

  it('passes all flag to Dockerode', async () => {
    await listContainers(false);
    expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: false });
  });
});

describe('listImages', () => {
  beforeEach(() => {
    setDockerClient(createMockDocker());
  });

  afterEach(() => {
    resetDockerClient();
  });

  it('returns mapped image info', async () => {
    const images = await listImages();

    expect(images).toHaveLength(1);
    expect(images[0]!.tags).toContain('postgres:16');
    expect(images[0]!.sizeMb).toBe(400);
    expect(images[0]!.id).toHaveLength(12);
  });
});

describe('listVolumes', () => {
  beforeEach(() => {
    setDockerClient(createMockDocker());
  });

  afterEach(() => {
    resetDockerClient();
  });

  it('returns mapped volume info', async () => {
    const volumes = await listVolumes();

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.name).toBe('platform-pgdata');
    expect(volumes[0]!.driver).toBe('local');
    expect(volumes[0]!.labels['com.platform']).toBe('true');
  });
});

describe('pingDocker', () => {
  afterEach(() => {
    resetDockerClient();
  });

  it('returns true when Docker responds', async () => {
    setDockerClient(createMockDocker());
    expect(await pingDocker()).toBe(true);
  });

  it('returns false when Docker is unreachable', async () => {
    setDockerClient(createMockDocker({
      ping: vi.fn().mockRejectedValue(new Error('connect ENOENT')),
    } as unknown as Partial<Docker>));
    expect(await pingDocker()).toBe(false);
  });
});
