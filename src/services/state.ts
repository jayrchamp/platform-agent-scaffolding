// ── State Service ───────────────────────────────────────────────────────────
//
// Persists AppSpecs, operations log, and agent version in /var/lib/platform/.
// Uses YAML for human-readable config, JSON for operations log (append-heavy).
//
// File layout on disk:
//   /var/lib/platform/
//     appspecs/          — one YAML file per app (e.g. my-app.yaml)
//     operations.log     — JSON Lines (one JSON object per line)
//     agent.yaml         — agent metadata (version, install date)
//
// Loaded at boot to recover previous state.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AppSpec {
  /** Unique app name (used as filename: <name>.yaml) */
  name: string;
  /** Docker image to deploy */
  image: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Domain(s) for Traefik routing */
  domains?: string[];
  /** PostgreSQL database name (if needed) */
  database?: string;
  /** Port the app listens on inside the container */
  port?: number;
  /** Desired state */
  desiredState: 'running' | 'stopped';
  /** Metadata */
  version?: string;
  createdAt: string;
  updatedAt: string;
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

// ── State manager ──────────────────────────────────────────────────────────

export class StateManager {
  private basePath: string;
  private appspecsDir: string;
  private opsLogPath: string;
  private agentMetaPath: string;

  /** In-memory cache of AppSpecs (loaded at boot) */
  private appspecs: Map<string, AppSpec> = new Map();

  constructor(basePath: string) {
    this.basePath = basePath;
    this.appspecsDir = join(basePath, 'appspecs');
    this.opsLogPath = join(basePath, 'operations.log');
    this.agentMetaPath = join(basePath, 'agent.yaml');
  }

  // ── Init ───────────────────────────────────────────────────────────────

  /** Initialize directories and load existing state from disk */
  init(): void {
    mkdirSync(this.appspecsDir, { recursive: true });

    // Load AppSpecs from disk
    this.loadAppSpecs();

    // Update agent meta
    this.updateAgentMeta();
  }

  // ── AppSpecs ───────────────────────────────────────────────────────────

  listAppSpecs(): AppSpec[] {
    return Array.from(this.appspecs.values());
  }

  getAppSpec(name: string): AppSpec | undefined {
    return this.appspecs.get(name);
  }

  saveAppSpec(spec: AppSpec): void {
    spec.updatedAt = new Date().toISOString();
    if (!spec.createdAt) {
      spec.createdAt = spec.updatedAt;
    }

    this.appspecs.set(spec.name, spec);

    // Persist to disk
    const filePath = join(this.appspecsDir, `${spec.name}.yaml`);
    writeFileSync(filePath, yaml.dump(spec, { lineWidth: 120 }), 'utf-8');
  }

  deleteAppSpec(name: string): boolean {
    if (!this.appspecs.has(name)) return false;

    this.appspecs.delete(name);
    const filePath = join(this.appspecsDir, `${name}.yaml`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return true;
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

  // ── Private ────────────────────────────────────────────────────────────

  private loadAppSpecs(): void {
    this.appspecs.clear();

    if (!existsSync(this.appspecsDir)) return;

    const files = readdirSync(this.appspecsDir).filter((f) => f.endsWith('.yaml'));

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.appspecsDir, file), 'utf-8');
        const spec = yaml.load(raw) as AppSpec;
        if (spec?.name) {
          this.appspecs.set(spec.name, spec);
        }
      } catch {
        // Skip corrupted files — log in production
      }
    }
  }
}
