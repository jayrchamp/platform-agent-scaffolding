// ── Apps Service ────────────────────────────────────────────────────────────
//
// Orchestrates app lifecycle: create container from AppSpec, start, stop,
// restart, deploy. Uses Docker service for container ops and StateManager
// for persistence + state transitions.

import {
  listContainers,
  createContainer,
  containerAction,
  getContainerLogs,
  type ContainerInfo,
  type CreateContainerOptions,
} from './docker.js';
import { buildFromRepo } from './build.js';
import type { HealthMonitor } from './health-monitor.js';
import type {
  StateManager,
  AppSpec,
  AppActualState,
  AppRuntimeState,
} from './state.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AppLifecycleResult {
  success: boolean;
  appName: string;
  action: string;
  state?: AppActualState;
  error?: string;
  containerInfo?: ContainerInfo;
}

// ── Container naming convention ────────────────────────────────────────────

function containerName(appName: string): string {
  return `app-${appName}`;
}

// ── Find app container ─────────────────────────────────────────────────────

export async function findAppContainer(appName: string): Promise<ContainerInfo | undefined> {
  const containers = await listContainers(true); // include stopped
  const name = containerName(appName);
  return containers.find((c) => c.name === name || c.name === `/${name}`);
}

// ── Build CreateContainerOptions from AppSpec ──────────────────────────────

function specToContainerOptions(spec: AppSpec, imageOverride?: string): CreateContainerOptions {
  const env: string[] = [];

  // Env vars from AppSpec
  if (spec.env) {
    for (const e of spec.env) {
      if (!e.isSecret) {
        env.push(`${e.key}=${e.value}`);
      }
      // Secrets are injected separately (via secrets manager) — not in plain env
    }
  }

  // Port mapping: use static hostPort if configured, otherwise let Docker pick
  const ports: Record<string, string> = {};
  if (spec.port) {
    ports[`${spec.port}/tcp`] = spec.hostPort ? `0.0.0.0:${spec.hostPort}` : `0.0.0.0:0`;
  }

  // Labels for Traefik routing
  const labels: Record<string, string> = {
    'platform.app': spec.name,
    'platform.managed': 'true',
  };

  // Traefik labels if domains configured
  if (spec.domains && spec.domains.length > 0) {
    const primaryDomain = spec.domains.find((d) => d.type === 'primary');
    if (primaryDomain && spec.port) {
      labels['traefik.enable'] = 'true';
      labels[`traefik.http.routers.${spec.name}.rule`] = `Host(\`${primaryDomain.domain}\`)`;
      labels[`traefik.http.routers.${spec.name}.entrypoints`] = 'websecure';
      labels[`traefik.http.routers.${spec.name}.tls.certresolver`] = 'letsencrypt';
      labels[`traefik.http.services.${spec.name}.loadbalancer.server.port`] = String(spec.port);
    }
  }

  const finalImage = imageOverride ?? spec.image;
  if (!finalImage) {
    throw new Error(`No image available for app '${spec.name}'. Build may have failed.`);
  }

  const options: CreateContainerOptions = {
    name: containerName(spec.name),
    image: finalImage,
    env,
    ports,
    network: 'platform-net',
    labels,
    restart: 'unless-stopped',
  };

  return options;
}

// ── Lifecycle operations ──────────────────────────────────────────────────

/**
 * Deploy an app: create container from AppSpec, start it, transition state.
 */
export async function deployApp(
  stateManager: StateManager,
  appName: string,
  healthMonitor?: HealthMonitor,
): Promise<AppLifecycleResult> {
  const spec = stateManager.getAppSpec(appName);
  if (!spec) {
    return { success: false, appName, action: 'deploy', error: 'AppSpec not found' };
  }

  // Log operation start
  const opId = `op_deploy_${appName}_${Date.now()}`;
  stateManager.logOperation({
    id: opId,
    type: 'deploy_app',
    target: appName,
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  try {
    // Transition to deploying
    stateManager.transitionAppState(appName, 'deploying');

    let imageTag: string | undefined;

    // ── Build step (if dockerfile strategy) ──
    const strategy = spec.buildStrategy ?? 'dockerfile';
    if (strategy === 'dockerfile') {
      if (!spec.repo?.url) {
        throw new Error('Cannot build from Dockerfile: no repo URL configured');
      }

      // Get current version for image tagging
      const meta = stateManager.getAppSpecMeta(appName);
      const version = meta?.currentVersion ?? 1;

      const buildResult = await buildFromRepo(
        appName,
        spec.repo.url,
        spec.repo.ref ?? 'main',
        version,
      );

      if (!buildResult.success) {
        throw new Error(`Build failed: ${buildResult.error}`);
      }

      imageTag = buildResult.imageTag;
    }

    // Guard: ensure hostPort isn't already claimed by another app
    if (spec.hostPort) {
      const conflict = stateManager.checkHostPortConflict(spec.hostPort, appName);
      if (conflict) {
        throw new Error(
          `Port ${spec.hostPort} is already assigned to app '${conflict}'. Choose a different public port.`,
        );
      }
    }

    // Remove existing container if any
    const existing = await findAppContainer(appName);
    if (existing) {
      await containerAction(existing.id, 'remove');
    }

    // Create and start new container
    const options = specToContainerOptions(spec, imageTag);
    const container = await createContainer(options);

    // If no hostPort was configured, persist the randomly assigned one so it stays stable on future deploys
    if (!spec.hostPort) {
      const assignedPort = container.ports.find(p => p.hostPort)?.hostPort;
      if (assignedPort) {
        const updatedSpec = { ...spec, hostPort: assignedPort };
        stateManager.saveAppSpec(updatedSpec, {
          changedBy: 'system',
          changeDescription: `Auto-assigned public port ${assignedPort} on first deploy`,
        });
      }
    }

    // Transition to running
    stateManager.transitionAppState(appName, 'running');

    // Start health monitoring
    healthMonitor?.startMonitoring(appName);

    // Log success
    stateManager.logOperation({
      id: opId,
      type: 'deploy_app',
      target: appName,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: `Container ${container.id} started${imageTag ? ` (built ${imageTag})` : ''}`,
    });

    return {
      success: true,
      appName,
      action: 'deploy',
      state: 'running',
      containerInfo: container,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    stateManager.transitionAppState(appName, 'error', errorMsg);

    stateManager.logOperation({
      id: opId,
      type: 'deploy_app',
      target: appName,
      status: 'failed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: errorMsg,
    });

    return { success: false, appName, action: 'deploy', error: errorMsg };
  }
}

/**
 * Start a stopped app container.
 */
export async function startApp(
  stateManager: StateManager,
  appName: string,
  healthMonitor?: HealthMonitor,
): Promise<AppLifecycleResult> {
  const container = await findAppContainer(appName);

  if (!container) {
    // No container exists — do a full deploy
    return deployApp(stateManager, appName, healthMonitor);
  }

  try {
    stateManager.transitionAppState(appName, 'deploying');
    await containerAction(container.id, 'start');
    stateManager.transitionAppState(appName, 'running');
    healthMonitor?.startMonitoring(appName);

    stateManager.logOperation({
      id: `op_start_${appName}_${Date.now()}`,
      type: 'start_app',
      target: appName,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return { success: true, appName, action: 'start', state: 'running' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    stateManager.transitionAppState(appName, 'error', errorMsg);
    return { success: false, appName, action: 'start', error: errorMsg };
  }
}

/**
 * Stop a running app container.
 */
export async function stopApp(
  stateManager: StateManager,
  appName: string,
  healthMonitor?: HealthMonitor,
): Promise<AppLifecycleResult> {
  const container = await findAppContainer(appName);

  if (!container) {
    healthMonitor?.stopMonitoring(appName);
    stateManager.transitionAppState(appName, 'stopped');
    return { success: true, appName, action: 'stop', state: 'stopped' };
  }

  try {
    healthMonitor?.stopMonitoring(appName);
    await containerAction(container.id, 'stop');
    stateManager.transitionAppState(appName, 'stopped');

    stateManager.logOperation({
      id: `op_stop_${appName}_${Date.now()}`,
      type: 'stop_app',
      target: appName,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return { success: true, appName, action: 'stop', state: 'stopped' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, appName, action: 'stop', error: errorMsg };
  }
}

/**
 * Restart a running app container.
 */
export async function restartApp(
  stateManager: StateManager,
  appName: string,
  healthMonitor?: HealthMonitor,
): Promise<AppLifecycleResult> {
  const container = await findAppContainer(appName);

  if (!container) {
    return deployApp(stateManager, appName, healthMonitor);
  }

  try {
    stateManager.transitionAppState(appName, 'updating');
    await containerAction(container.id, 'restart');
    stateManager.transitionAppState(appName, 'running');
    // Restart monitoring (resets failure count via stopMonitoring + startMonitoring)
    healthMonitor?.stopMonitoring(appName);
    healthMonitor?.startMonitoring(appName);

    stateManager.logOperation({
      id: `op_restart_${appName}_${Date.now()}`,
      type: 'restart_app',
      target: appName,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return { success: true, appName, action: 'restart', state: 'running' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    stateManager.transitionAppState(appName, 'error', errorMsg);
    return { success: false, appName, action: 'restart', error: errorMsg };
  }
}

/**
 * Get logs for an app container.
 */
export async function getAppLogs(
  appName: string,
  tail = 100,
): Promise<{ logs: string; found: boolean }> {
  const container = await findAppContainer(appName);
  if (!container) {
    return { logs: '', found: false };
  }

  const logs = await getContainerLogs(container.id, tail);
  return { logs, found: true };
}
