// ── Docker Service ──────────────────────────────────────────────────────────
//
// Wraps Dockerode to communicate with Docker Engine via Unix socket.
// No direct docker CLI — everything goes through the API.
//
// Used by the Docker module (routes) and will be used by PostgreSQL module
// for container lifecycle.

import Docker from 'dockerode';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;       // running, exited, paused, restarting, etc.
  status: string;      // "Up 3 hours", "Exited (0) 2 hours ago"
  createdAt: string;
  ports: PortMapping[];
  labels: Record<string, string>;
  networkMode: string;
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  hostIp?: string;
  protocol: string;
}

export interface ImageInfo {
  id: string;
  tags: string[];
  sizeMb: number;
  createdAt: string;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface CreateContainerOptions {
  name: string;
  image: string;
  env?: string[];
  ports?: Record<string, string>;  // containerPort/proto → hostBinding (e.g. "5432/tcp" → "127.0.0.1:5432")
  volumes?: Record<string, string>; // hostPath → containerPath[:ro]
  network?: string;
  labels?: Record<string, string>;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  cmd?: string[];
}

export interface ContainerActionResult {
  containerId: string;
  action: string;
  success: boolean;
  error?: string;
}

// ── Docker client singleton ────────────────────────────────────────────────

let docker: Docker | null = null;

function getDocker(): Docker {
  if (!docker) {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }
  return docker;
}

/** Override Docker client (for tests) */
export function setDockerClient(client: Docker): void {
  docker = client;
}

/** Reset to default (for tests) */
export function resetDockerClient(): void {
  docker = null;
}

// ── Containers ─────────────────────────────────────────────────────────────

export async function listContainers(all = true): Promise<ContainerInfo[]> {
  const d = getDocker();
  const containers = await d.listContainers({ all });

  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names[0] ?? '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    createdAt: new Date(c.Created * 1000).toISOString(),
    ports: (c.Ports ?? []).map((p) => ({
      containerPort: p.PrivatePort,
      hostPort: p.PublicPort,
      hostIp: p.IP,
      protocol: p.Type,
    })),
    labels: c.Labels ?? {},
    networkMode: Object.keys(c.NetworkSettings?.Networks ?? {})[0] ?? 'unknown',
  }));
}

export async function createContainer(options: CreateContainerOptions): Promise<ContainerInfo> {
  const d = getDocker();

  // Build port bindings
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>> = {};

  if (options.ports) {
    for (const [containerPort, hostBinding] of Object.entries(options.ports)) {
      exposedPorts[containerPort] = {};
      const [hostIp, hostPort] = hostBinding.includes(':')
        ? hostBinding.split(':')
        : [undefined, hostBinding];
      portBindings[containerPort] = [{ HostPort: hostPort!, ...(hostIp ? { HostIp: hostIp } : {}) }];
    }
  }

  // Build volume bindings
  const binds: string[] = [];
  if (options.volumes) {
    for (const [hostPath, containerPath] of Object.entries(options.volumes)) {
      binds.push(`${hostPath}:${containerPath}`);
    }
  }

  // Build restart policy
  const restartPolicy = options.restart
    ? { Name: options.restart, ...(options.restart === 'on-failure' ? { MaximumRetryCount: 5 } : {}) }
    : { Name: 'no' as const };

  const container = await d.createContainer({
    name: options.name,
    Image: options.image,
    Env: options.env,
    ExposedPorts: exposedPorts,
    Labels: options.labels,
    Cmd: options.cmd,
    HostConfig: {
      Binds: binds.length > 0 ? binds : undefined,
      PortBindings: portBindings,
      RestartPolicy: restartPolicy,
      NetworkMode: options.network,
    },
  });

  // Start the container
  await container.start();

  // Fetch full info to return
  const info = await container.inspect();

  // Parse actual port bindings from inspect result
  const ports: PortMapping[] = [];
  const bindings = info.NetworkSettings?.Ports ?? {};
  for (const [portProto, hostBindings] of Object.entries(bindings)) {
    const [containerPortStr, protocol] = portProto.split('/');
    const containerPort = parseInt(containerPortStr ?? '0', 10);
    if (!hostBindings || hostBindings.length === 0) {
      ports.push({ containerPort, protocol: protocol ?? 'tcp' });
    } else {
      for (const b of hostBindings) {
        ports.push({
          containerPort,
          hostPort: b.HostPort ? parseInt(b.HostPort, 10) : undefined,
          hostIp: b.HostIp || undefined,
          protocol: protocol ?? 'tcp',
        });
      }
    }
  }

  return {
    id: info.Id.slice(0, 12),
    name: info.Name.replace(/^\//, ''),
    image: info.Config.Image,
    state: info.State.Status,
    status: info.State.Running ? `Up since ${info.State.StartedAt}` : info.State.Status,
    createdAt: info.Created,
    ports,
    labels: info.Config.Labels ?? {},
    networkMode: info.HostConfig.NetworkMode ?? 'default',
  };
}

export async function containerAction(
  nameOrId: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
): Promise<ContainerActionResult> {
  const d = getDocker();
  const container = d.getContainer(nameOrId);

  try {
    switch (action) {
      case 'start':
        await container.start();
        break;
      case 'stop':
        await container.stop({ t: 10 });
        break;
      case 'restart':
        await container.restart({ t: 10 });
        break;
      case 'remove':
        await container.stop({ t: 10 }).catch(() => {}); // might already be stopped
        await container.remove({ force: true });
        break;
    }
    return { containerId: nameOrId, action, success: true };
  } catch (err) {
    return {
      containerId: nameOrId,
      action,
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function getContainerLogs(
  nameOrId: string,
  tail = 100,
): Promise<string> {
  const d = getDocker();
  const container = d.getContainer(nameOrId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });

  // Dockerode returns a Buffer or string depending on tty setting
  return typeof logs === 'string' ? logs : logs.toString('utf-8');
}

// ── Images ─────────────────────────────────────────────────────────────────

export async function listImages(): Promise<ImageInfo[]> {
  const d = getDocker();
  const images = await d.listImages();

  return images.map((img) => ({
    id: (img.Id ?? '').replace('sha256:', '').slice(0, 12),
    tags: img.RepoTags ?? ['<none>'],
    sizeMb: Math.round((img.Size ?? 0) / 1024 / 1024),
    createdAt: new Date((img.Created ?? 0) * 1000).toISOString(),
  }));
}

// ── Volumes ────────────────────────────────────────────────────────────────

export async function listVolumes(): Promise<VolumeInfo[]> {
  const d = getDocker();
  const { Volumes } = await d.listVolumes();

  return (Volumes ?? []).map((vol) => ({
    name: vol.Name,
    driver: vol.Driver,
    mountpoint: vol.Mountpoint,
    createdAt: (vol as unknown as { CreatedAt?: string }).CreatedAt ?? '',
    labels: vol.Labels ?? {},
  }));
}

// ── Health check ───────────────────────────────────────────────────────────

/** Quick Docker connectivity check */
export async function pingDocker(): Promise<boolean> {
  try {
    const d = getDocker();
    await d.ping();
    return true;
  } catch {
    return false;
  }
}
