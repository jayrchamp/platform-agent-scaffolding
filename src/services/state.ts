// ── State Service ───────────────────────────────────────────────────────────
//
// Persists versioned AppSpecs, operations log, and agent metadata.
//
// File layout on disk:
//   /var/lib/platform/
//     appspecs/
//       <name>/
//         current.json       — active AppSpec
//         meta.json           — version counter + timestamps
//         versions/
//           1.json            — version 1 snapshot
//           2.json            — version 2 snapshot (current)
//     operations.log          — JSON Lines (one JSON object per line)
//     agent.yaml              — agent metadata (version, install date)
//
// Migration: if legacy YAML files exist (e.g. my-app.yaml), they are
// automatically converted to the versioned directory structure at boot.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

// ── Types ──────────────────────────────────────────────────────────────────

/** AppSpec as persisted on disk (agent-side source of truth) */
export type AppSpecBuildStrategy = 'dockerfile' | 'image';

export interface AppSpec {
  /** Unique app name (used as directory name) */
  name: string;
  /** Repository source */
  repo?: {
    url: string;
    ref: string;
    isPrivate: boolean;
  };
  /** Docker image (required for 'image' strategy, set by agent after build for 'dockerfile') */
  image?: string;
  /** How to obtain the Docker image (default: 'dockerfile') */
  buildStrategy: AppSpecBuildStrategy;
  /** Port the app listens on inside the container */
  port?: number;
  /** Desired operational state */
  desiredState: 'running' | 'stopped';
  /** Domain(s) for Traefik routing */
  domains?: Array<{
    domain: string;
    type: 'primary' | 'alias';
  }>;
  /** Environment variables */
  env?: Array<{
    key: string;
    value: string;
    isSecret: boolean;
  }>;
  /** Resource limits */
  resources?: {
    memoryMb: number;
    cpuShares: number;
  };
  /** Health check config */
  health?: {
    endpoint: string;
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
  };
  /** PostgreSQL database */
  postgres?: {
    dbName: string;
    user: string;
  };
  /** Metadata */
  metadata?: {
    description?: string;
    tags?: string[];
  };
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}

/** A single field-level change */
export interface AppSpecChange {
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Diff between two versions */
export interface AppSpecDiff {
  changes: AppSpecChange[];
}

/** Versioned snapshot */
export interface AppSpecVersion {
  version: number;
  spec: AppSpec;
  changedBy: 'user' | 'system';
  changeDescription?: string;
  diff: AppSpecDiff | null;
  createdAt: string;
}

/** Metadata file for a versioned AppSpec */
export interface AppSpecMeta {
  name: string;
  currentVersion: number;
  totalVersions: number;
  createdAt: string;
  updatedAt: string;
}

// ── App runtime state (actual state, separate from desired state) ──────────

export type AppActualState =
  | 'creating'
  | 'deploying'
  | 'running'
  | 'updating'
  | 'degraded'
  | 'stopped'
  | 'error';

export const VALID_STATE_TRANSITIONS: Record<AppActualState, AppActualState[]> = {
  creating: ['deploying', 'error'],
  deploying: ['running', 'error'],
  running: ['updating', 'degraded', 'stopped'],
  updating: ['running', 'error'],
  degraded: ['running', 'stopped', 'error'],
  stopped: ['deploying', 'creating'],
  error: ['deploying', 'stopped'],
};

export interface AppRuntimeState {
  /** App name (matches AppSpec name) */
  name: string;
  /** Current actual state */
  state: AppActualState;
  /** Last state change timestamp */
  updatedAt: string;
  /** Error message if in error state */
  error?: string;
}

export interface OperationLogEntry {
  id: string;
  type: string;
  target: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface AgentMeta {
  version: string;
  installedAt: string;
  lastStartedAt: string;
}

// ── Legacy AppSpec (for migration) ─────────────────────────────────────────

interface LegacyAppSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  domains?: string[];
  database?: string;
  port?: number;
  desiredState: 'running' | 'stopped';
  version?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Diff utility ──────────────────────────────────────────────────────────

function computeDiff(oldSpec: AppSpec, newSpec: AppSpec): AppSpecDiff {
  const changes: AppSpecChange[] = [];

  // Fields to compare (skip timestamps)
  const fields: (keyof AppSpec)[] = [
    'name', 'repo', 'image', 'port', 'desiredState',
    'domains', 'env', 'resources', 'health', 'postgres', 'metadata',
  ];

  for (const field of fields) {
    const a = oldSpec[field];
    const b = newSpec[field];
    const aJson = JSON.stringify(a ?? null);
    const bJson = JSON.stringify(b ?? null);

    if (aJson !== bJson) {
      changes.push({ path: field, oldValue: a, newValue: b });
    }
  }

  return { changes };
}

// ── State manager ──────────────────────────────────────────────────────────

export class StateManager {
  private basePath: string;
  private appspecsDir: string;
  private opsLogPath: string;
  private agentMetaPath: string;

  /** In-memory cache: name → { meta, current spec, versions loaded on-demand } */
  private appspecs: Map<string, { meta: AppSpecMeta; current: AppSpec }> = new Map();

  /** In-memory runtime states (loaded from disk at boot) */
  private runtimeStates: Map<string, AppRuntimeState> = new Map();

  constructor(basePath: string) {
    this.basePath = basePath;
    this.appspecsDir = join(basePath, 'appspecs');
    this.opsLogPath = join(basePath, 'operations.log');
    this.agentMetaPath = join(basePath, 'agent.yaml');
  }

  // ── Init ───────────────────────────────────────────────────────────────

  /** Initialize directories, migrate legacy data, load state from disk */
  init(): void {
    mkdirSync(this.appspecsDir, { recursive: true });

    // Migrate legacy YAML files if present
    this.migrateLegacySpecs();

    // Load versioned AppSpecs from disk
    this.loadAppSpecs();

    // Load runtime states from disk
    this.loadRuntimeStates();

    // Update agent meta
    this.updateAgentMeta();
  }

  // ── AppSpecs — CRUD ───────────────────────────────────────────────────

  listAppSpecs(): AppSpec[] {
    return Array.from(this.appspecs.values()).map((e) => e.current);
  }

  getAppSpec(name: string): AppSpec | undefined {
    return this.appspecs.get(name)?.current;
  }

  getAppSpecMeta(name: string): AppSpecMeta | undefined {
    return this.appspecs.get(name)?.meta;
  }

  /**
   * Save an AppSpec, creating a new version.
   * Returns the created AppSpecVersion.
   */
  saveAppSpec(
    spec: AppSpec,
    options: { changedBy?: 'user' | 'system'; changeDescription?: string } = {},
  ): AppSpecVersion {
    const now = new Date().toISOString();
    spec.updatedAt = now;

    const existing = this.appspecs.get(spec.name);
    const appDir = join(this.appspecsDir, spec.name);
    const versionsDir = join(appDir, 'versions');

    let newVersionNum: number;
    let diff: AppSpecDiff | null = null;

    if (existing) {
      // Update — compute diff and increment version
      newVersionNum = existing.meta.currentVersion + 1;
      diff = computeDiff(existing.current, spec);
    } else {
      // Create — version 1
      newVersionNum = 1;
      spec.createdAt = spec.createdAt || now;
      mkdirSync(versionsDir, { recursive: true });
    }

    const version: AppSpecVersion = {
      version: newVersionNum,
      spec,
      changedBy: options.changedBy ?? 'user',
      changeDescription: options.changeDescription,
      diff,
      createdAt: now,
    };

    const meta: AppSpecMeta = {
      name: spec.name,
      currentVersion: newVersionNum,
      totalVersions: newVersionNum,
      createdAt: existing?.meta.createdAt ?? spec.createdAt,
      updatedAt: now,
    };

    // Persist to disk
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(join(appDir, 'current.json'), JSON.stringify(spec, null, 2), 'utf-8');
    writeFileSync(join(appDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
    writeFileSync(join(versionsDir, `${newVersionNum}.json`), JSON.stringify(version, null, 2), 'utf-8');

    // Update in-memory cache
    this.appspecs.set(spec.name, { meta, current: spec });

    return version;
  }

  deleteAppSpec(name: string): boolean {
    if (!this.appspecs.has(name)) return false;

    this.appspecs.delete(name);
    this.runtimeStates.delete(name);

    const appDir = join(this.appspecsDir, name);
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }

    return true;
  }

  // ── AppSpecs — Versioning ─────────────────────────────────────────────

  /** Get the version history for an app (metadata only, not full specs) */
  getVersionHistory(name: string): AppSpecVersion[] {
    const entry = this.appspecs.get(name);
    if (!entry) return [];

    const versionsDir = join(this.appspecsDir, name, 'versions');
    if (!existsSync(versionsDir)) return [];

    const files = readdirSync(versionsDir)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('.json', ''), 10);
        const numB = parseInt(b.replace('.json', ''), 10);
        return numB - numA; // newest first
      });

    const versions: AppSpecVersion[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(versionsDir, file), 'utf-8');
        versions.push(JSON.parse(raw) as AppSpecVersion);
      } catch {
        // Skip corrupted version files
      }
    }

    return versions;
  }

  /** Get a specific version */
  getVersion(name: string, version: number): AppSpecVersion | undefined {
    const versionPath = join(this.appspecsDir, name, 'versions', `${version}.json`);
    if (!existsSync(versionPath)) return undefined;

    try {
      const raw = readFileSync(versionPath, 'utf-8');
      return JSON.parse(raw) as AppSpecVersion;
    } catch {
      return undefined;
    }
  }

  /**
   * Rollback to a previous version.
   * Creates a NEW version with the old spec (history is never rewritten).
   */
  rollbackAppSpec(name: string, toVersion: number): AppSpecVersion | undefined {
    const targetVersion = this.getVersion(name, toVersion);
    if (!targetVersion) return undefined;

    // Create a new version from the old spec
    return this.saveAppSpec(
      { ...targetVersion.spec, updatedAt: new Date().toISOString() },
      {
        changedBy: 'user',
        changeDescription: `Rollback to version ${toVersion}`,
      },
    );
  }

  /** Compute diff between two arbitrary versions */
  diffVersions(name: string, fromVersion: number, toVersion: number): AppSpecDiff | undefined {
    const from = this.getVersion(name, fromVersion);
    const to = this.getVersion(name, toVersion);
    if (!from || !to) return undefined;

    return computeDiff(from.spec, to.spec);
  }

  /** Export an AppSpec with its metadata (for import on another VPS) */
  exportAppSpec(name: string): { spec: AppSpec; meta: AppSpecMeta } | undefined {
    const entry = this.appspecs.get(name);
    if (!entry) return undefined;

    return { spec: entry.current, meta: entry.meta };
  }

  /** Import an AppSpec from another VPS, creating it as version 1 */
  importAppSpec(spec: AppSpec): AppSpecVersion {
    // If the name already exists, the caller must handle conflict
    return this.saveAppSpec(spec, {
      changedBy: 'system',
      changeDescription: 'Imported from another VPS',
    });
  }

  // ── App runtime state ──────────────────────────────────────────────────

  /** Get the runtime state for an app */
  getAppState(name: string): AppRuntimeState | undefined {
    return this.runtimeStates.get(name);
  }

  /** Get all runtime states */
  listAppStates(): AppRuntimeState[] {
    return Array.from(this.runtimeStates.values());
  }

  /**
   * Transition an app to a new state.
   * Validates the transition against the state machine.
   * Returns the new state, or undefined if the transition is invalid.
   */
  transitionAppState(
    name: string,
    newState: AppActualState,
    error?: string,
  ): AppRuntimeState | undefined {
    const current = this.runtimeStates.get(name);
    const currentState = current?.state;

    // If app doesn't have a runtime state yet, allow initial states
    if (!currentState) {
      if (newState !== 'creating' && newState !== 'stopped') {
        return undefined;
      }
    } else {
      // Validate transition
      const allowed = VALID_STATE_TRANSITIONS[currentState];
      if (!allowed.includes(newState)) {
        return undefined;
      }
    }

    const state: AppRuntimeState = {
      name,
      state: newState,
      updatedAt: new Date().toISOString(),
      error: newState === 'error' ? error : undefined,
    };

    this.runtimeStates.set(name, state);
    this.persistRuntimeState(name, state);

    return state;
  }

  /** Remove runtime state (e.g., on app deletion) */
  removeAppState(name: string): void {
    this.runtimeStates.delete(name);
    const statePath = join(this.appspecsDir, name, 'runtime.json');
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
  }

  private persistRuntimeState(name: string, state: AppRuntimeState): void {
    const appDir = join(this.appspecsDir, name);
    if (!existsSync(appDir)) return;

    writeFileSync(
      join(appDir, 'runtime.json'),
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  }

  private loadRuntimeStates(): void {
    this.runtimeStates.clear();

    if (!existsSync(this.appspecsDir)) return;

    const entries = readdirSync(this.appspecsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const runtimePath = join(this.appspecsDir, entry.name, 'runtime.json');
      if (!existsSync(runtimePath)) continue;

      try {
        const raw = readFileSync(runtimePath, 'utf-8');
        const state = JSON.parse(raw) as AppRuntimeState;
        if (state?.name) {
          this.runtimeStates.set(state.name, state);
        }
      } catch {
        // Skip corrupted state files
      }
    }
  }

  // ── Operations log ─────────────────────────────────────────────────────

  logOperation(entry: OperationLogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.opsLogPath, line, 'utf-8');
  }

  getRecentOperations(limit = 50): OperationLogEntry[] {
    if (!existsSync(this.opsLogPath)) return [];

    try {
      const content = readFileSync(this.opsLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Take last N lines
      const recent = lines.slice(-limit);
      return recent
        .map((line) => {
          try {
            return JSON.parse(line) as OperationLogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is OperationLogEntry => e !== null)
        .reverse(); // newest first
    } catch {
      return [];
    }
  }

  /** Find operations still marked as 'running' — used by boot cleanup (Story 5.6) */
  getStaleOperations(maxAgeMs = 30 * 60 * 1000): OperationLogEntry[] {
    const ops = this.getRecentOperations(200);
    const now = Date.now();

    return ops.filter((op) => {
      if (op.status !== 'running') return false;
      const started = new Date(op.startedAt).getTime();
      return now - started > maxAgeMs;
    });
  }

  /** Mark a running operation as failed (used by boot cleanup) */
  markOperationFailed(id: string, error: string): void {
    this.logOperation({
      id,
      type: 'cleanup',
      target: id,
      status: 'failed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error,
    });
  }

  // ── Agent metadata ─────────────────────────────────────────────────────

  getAgentMeta(): AgentMeta | null {
    if (!existsSync(this.agentMetaPath)) return null;

    try {
      const raw = readFileSync(this.agentMetaPath, 'utf-8');
      return yaml.load(raw) as AgentMeta;
    } catch {
      return null;
    }
  }

  private updateAgentMeta(): void {
    const existing = this.getAgentMeta();
    const meta: AgentMeta = {
      version: existing?.version ?? '1.0.0',
      installedAt: existing?.installedAt ?? new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
    };

    writeFileSync(this.agentMetaPath, yaml.dump(meta), 'utf-8');
  }

  // ── Private — loading ─────────────────────────────────────────────────

  private loadAppSpecs(): void {
    this.appspecs.clear();

    if (!existsSync(this.appspecsDir)) return;

    const entries = readdirSync(this.appspecsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const appDir = join(this.appspecsDir, entry.name);
      const currentPath = join(appDir, 'current.json');
      const metaPath = join(appDir, 'meta.json');

      if (!existsSync(currentPath) || !existsSync(metaPath)) continue;

      try {
        const spec = JSON.parse(readFileSync(currentPath, 'utf-8')) as AppSpec;
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as AppSpecMeta;

        if (spec?.name) {
          this.appspecs.set(spec.name, { meta, current: spec });
        }
      } catch {
        // Skip corrupted directories
      }
    }
  }

  // ── Private — legacy migration ────────────────────────────────────────

  /**
   * Migrate legacy YAML flat files (my-app.yaml) to versioned directory structure.
   * Only runs once — if a .yaml file exists at the appspecs root, it gets migrated.
   */
  private migrateLegacySpecs(): void {
    if (!existsSync(this.appspecsDir)) return;

    const files = readdirSync(this.appspecsDir).filter((f) => f.endsWith('.yaml'));
    if (files.length === 0) return;

    for (const file of files) {
      const filePath = join(this.appspecsDir, file);

      try {
        const raw = readFileSync(filePath, 'utf-8');
        const legacy = yaml.load(raw) as LegacyAppSpec;
        if (!legacy?.name) continue;

        // Convert legacy format to new AppSpec
        const spec: AppSpec = {
          name: legacy.name,
          image: legacy.image,
          buildStrategy: legacy.image ? 'image' : 'dockerfile',
          port: legacy.port,
          desiredState: legacy.desiredState ?? 'running',
          createdAt: legacy.createdAt ?? new Date().toISOString(),
          updatedAt: legacy.updatedAt ?? new Date().toISOString(),
        };

        // Convert legacy env (Record → array)
        if (legacy.env && typeof legacy.env === 'object') {
          spec.env = Object.entries(legacy.env).map(([key, value]) => ({
            key,
            value,
            isSecret: false,
          }));
        }

        // Convert legacy domains (string[] → object[])
        if (legacy.domains && Array.isArray(legacy.domains)) {
          spec.domains = legacy.domains.map((d, i) => ({
            domain: d,
            type: i === 0 ? 'primary' as const : 'alias' as const,
          }));
        }

        // Convert legacy database
        if (legacy.database) {
          spec.postgres = {
            dbName: legacy.database,
            user: legacy.name, // convention: user = app name
          };
        }

        // Create versioned structure
        const appDir = join(this.appspecsDir, spec.name);
        const versionsDir = join(appDir, 'versions');
        mkdirSync(versionsDir, { recursive: true });

        const meta: AppSpecMeta = {
          name: spec.name,
          currentVersion: 1,
          totalVersions: 1,
          createdAt: spec.createdAt,
          updatedAt: spec.updatedAt,
        };

        const version: AppSpecVersion = {
          version: 1,
          spec,
          changedBy: 'system',
          changeDescription: 'Migrated from legacy YAML format',
          diff: null,
          createdAt: spec.createdAt,
        };

        writeFileSync(join(appDir, 'current.json'), JSON.stringify(spec, null, 2), 'utf-8');
        writeFileSync(join(appDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        writeFileSync(join(versionsDir, '1.json'), JSON.stringify(version, null, 2), 'utf-8');

        // Remove legacy file
        unlinkSync(filePath);
      } catch {
        // If migration fails for one file, skip it — don't crash agent boot
      }
    }
  }
}
