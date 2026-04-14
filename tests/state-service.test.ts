// ── State Service Tests ─────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { StateManager, type AppSpec, type OperationLogEntry } from '../src/services/state.js';

let tmpDir: string;
let state: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-state-'));
  state = new StateManager(tmpDir);
  state.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

const baseSpec: AppSpec = {
  name: 'my-app',
  image: 'my-app:latest',
  desiredState: 'running',
  port: 3000,
  createdAt: '',
  updatedAt: '',
};

// ── AppSpec CRUD ──────────────────────────────────────────────────────────

describe('AppSpec CRUD', () => {
  it('starts with no appspecs', () => {
    expect(state.listAppSpecs()).toHaveLength(0);
  });

  it('saves and retrieves an appspec', () => {
    state.saveAppSpec({ ...baseSpec });
    const fetched = state.getAppSpec('my-app');

    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('my-app');
    expect(fetched!.image).toBe('my-app:latest');
    expect(fetched!.updatedAt).toBeTruthy();
  });

  it('lists all appspecs', () => {
    state.saveAppSpec({ ...baseSpec, name: 'app-a' });
    state.saveAppSpec({ ...baseSpec, name: 'app-b' });

    expect(state.listAppSpecs()).toHaveLength(2);
  });

  it('updates an existing appspec', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });

    const fetched = state.getAppSpec('my-app');
    expect(fetched!.image).toBe('my-app:v2');
  });

  it('deletes an appspec and its directory', () => {
    state.saveAppSpec({ ...baseSpec });
    expect(state.deleteAppSpec('my-app')).toBe(true);
    expect(state.getAppSpec('my-app')).toBeUndefined();
    expect(state.listAppSpecs()).toHaveLength(0);
  });

  it('returns false when deleting non-existent appspec', () => {
    expect(state.deleteAppSpec('no-such-app')).toBe(false);
  });

  it('persists to disk and survives reload', () => {
    state.saveAppSpec({ ...baseSpec });

    const state2 = new StateManager(tmpDir);
    state2.init();

    expect(state2.getAppSpec('my-app')).toBeDefined();
    expect(state2.getAppSpec('my-app')!.image).toBe('my-app:latest');
  });
});

// ── Versioning ────────────────────────────────────────────────────────────

describe('AppSpec versioning', () => {
  it('creates version 1 on first save', () => {
    const version = state.saveAppSpec({ ...baseSpec });

    expect(version.version).toBe(1);
    expect(version.diff).toBeNull();
    expect(version.changedBy).toBe('user');
  });

  it('increments version on update', () => {
    state.saveAppSpec({ ...baseSpec });
    const v2 = state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });

    expect(v2.version).toBe(2);
  });

  it('records metadata correctly', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });

    const meta = state.getAppSpecMeta('my-app');
    expect(meta).toBeDefined();
    expect(meta!.currentVersion).toBe(2);
    expect(meta!.totalVersions).toBe(2);
  });

  it('computes diff between versions', () => {
    state.saveAppSpec({ ...baseSpec });
    const v2 = state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });

    expect(v2.diff).toBeDefined();
    expect(v2.diff!.changes).toHaveLength(1);
    expect(v2.diff!.changes[0]!.path).toBe('image');
    expect(v2.diff!.changes[0]!.oldValue).toBe('my-app:latest');
    expect(v2.diff!.changes[0]!.newValue).toBe('my-app:v2');
  });

  it('stores change description', () => {
    state.saveAppSpec({ ...baseSpec });
    const v2 = state.saveAppSpec(
      { ...baseSpec, image: 'my-app:v2' },
      { changeDescription: 'Upgrade to v2' },
    );

    expect(v2.changeDescription).toBe('Upgrade to v2');
  });

  it('retrieves version history newest-first', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v3' });

    const history = state.getVersionHistory('my-app');
    expect(history).toHaveLength(3);
    expect(history[0]!.version).toBe(3);
    expect(history[2]!.version).toBe(1);
  });

  it('retrieves a specific version', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });

    const v1 = state.getVersion('my-app', 1);
    expect(v1).toBeDefined();
    expect(v1!.spec.image).toBe('my-app:latest');

    const v2 = state.getVersion('my-app', 2);
    expect(v2).toBeDefined();
    expect(v2!.spec.image).toBe('my-app:v2');
  });

  it('returns undefined for non-existent version', () => {
    state.saveAppSpec({ ...baseSpec });
    expect(state.getVersion('my-app', 99)).toBeUndefined();
  });
});

// ── Rollback ──────────────────────────────────────────────────────────────

describe('Rollback', () => {
  it('rolls back by creating a new version with old spec', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v3' });

    const result = state.rollbackAppSpec('my-app', 1);

    expect(result).toBeDefined();
    expect(result!.version).toBe(4); // new version, not overwrite
    expect(result!.spec.image).toBe('my-app:latest'); // v1 image
    expect(result!.changeDescription).toBe('Rollback to version 1');
  });

  it('rollback does not destroy history', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2' });
    state.rollbackAppSpec('my-app', 1);

    const history = state.getVersionHistory('my-app');
    expect(history).toHaveLength(3); // v1, v2, v3 (rollback)
  });

  it('returns undefined when rolling back to non-existent version', () => {
    state.saveAppSpec({ ...baseSpec });
    expect(state.rollbackAppSpec('my-app', 99)).toBeUndefined();
  });
});

// ── Diff ──────────────────────────────────────────────────────────────────

describe('Diff between arbitrary versions', () => {
  it('computes diff between any two versions', () => {
    state.saveAppSpec({ ...baseSpec });
    state.saveAppSpec({ ...baseSpec, image: 'my-app:v2', port: 8080 });

    const diff = state.diffVersions('my-app', 1, 2);
    expect(diff).toBeDefined();
    expect(diff!.changes.length).toBeGreaterThanOrEqual(2); // image + port
  });

  it('returns undefined when versions do not exist', () => {
    state.saveAppSpec({ ...baseSpec });
    expect(state.diffVersions('my-app', 1, 99)).toBeUndefined();
  });
});

// ── Export / Import ───────────────────────────────────────────────────────

describe('Export / Import', () => {
  it('exports spec + meta', () => {
    state.saveAppSpec({ ...baseSpec });

    const exported = state.exportAppSpec('my-app');
    expect(exported).toBeDefined();
    expect(exported!.spec.name).toBe('my-app');
    expect(exported!.meta.currentVersion).toBe(1);
  });

  it('imports a spec as version 1', () => {
    const imported = state.importAppSpec({ ...baseSpec, name: 'imported-app' });

    expect(imported.version).toBe(1);
    expect(imported.changeDescription).toBe('Imported from another VPS');
    expect(state.getAppSpec('imported-app')).toBeDefined();
  });

  it('returns undefined when exporting non-existent app', () => {
    expect(state.exportAppSpec('no-such-app')).toBeUndefined();
  });
});

// ── Legacy YAML migration ─────────────────────────────────────────────────

describe('Legacy YAML migration', () => {
  it('migrates legacy YAML files to versioned directories', () => {
    // Create a fresh tmpDir with legacy files
    const legacyDir = mkdtempSync(join(tmpdir(), 'platform-legacy-'));
    const appspecsDir = join(legacyDir, 'appspecs');
    mkdirSync(appspecsDir, { recursive: true });

    // Write a legacy YAML file
    const legacySpec = {
      name: 'legacy-app',
      image: 'legacy:v1',
      env: { NODE_ENV: 'production', PORT: '3000' },
      domains: ['example.com', 'www.example.com'],
      database: 'legacy_db',
      port: 3000,
      desiredState: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    writeFileSync(join(appspecsDir, 'legacy-app.yaml'), yaml.dump(legacySpec), 'utf-8');

    // Boot a new StateManager — migration should happen
    const migratedState = new StateManager(legacyDir);
    migratedState.init();

    // Check that the spec was migrated
    const spec = migratedState.getAppSpec('legacy-app');
    expect(spec).toBeDefined();
    expect(spec!.image).toBe('legacy:v1');

    // Check converted env format (Record → array)
    expect(spec!.env).toBeDefined();
    expect(Array.isArray(spec!.env)).toBe(true);
    expect(spec!.env).toHaveLength(2);
    expect(spec!.env![0]!.key).toBe('NODE_ENV');

    // Check converted domains (string[] → object[])
    expect(spec!.domains).toBeDefined();
    expect(spec!.domains![0]!.type).toBe('primary');
    expect(spec!.domains![1]!.type).toBe('alias');

    // Check converted database
    expect(spec!.postgres).toBeDefined();
    expect(spec!.postgres!.dbName).toBe('legacy_db');

    // Check versioning was set up
    const meta = migratedState.getAppSpecMeta('legacy-app');
    expect(meta).toBeDefined();
    expect(meta!.currentVersion).toBe(1);

    const v1 = migratedState.getVersion('legacy-app', 1);
    expect(v1).toBeDefined();
    expect(v1!.changeDescription).toBe('Migrated from legacy YAML format');

    rmSync(legacyDir, { recursive: true, force: true });
  });
});

// ── Operations log ────────────────────────────────────────────────────────

describe('Operations log', () => {
  it('starts with no operations', () => {
    expect(state.getRecentOperations()).toHaveLength(0);
  });

  it('logs and retrieves operations', () => {
    const op: OperationLogEntry = {
      id: 'op-1',
      type: 'deploy',
      target: 'my-app',
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    state.logOperation(op);
    const recent = state.getRecentOperations();

    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe('op-1');
  });

  it('returns newest first', () => {
    state.logOperation({
      id: 'op-1', type: 'deploy', target: 'a', status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
    });
    state.logOperation({
      id: 'op-2', type: 'deploy', target: 'b', status: 'completed',
      startedAt: '2026-01-02T00:00:00Z',
    });

    const recent = state.getRecentOperations();
    expect(recent[0]!.id).toBe('op-2');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      state.logOperation({
        id: `op-${i}`, type: 'deploy', target: 'app', status: 'completed',
        startedAt: new Date().toISOString(),
      });
    }

    expect(state.getRecentOperations(3)).toHaveLength(3);
  });
});

// ── Stale operations ──────────────────────────────────────────────────────

describe('Stale operations', () => {
  it('detects operations running longer than maxAge', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.logOperation({
      id: 'stale-op', type: 'deploy', target: 'app', status: 'running',
      startedAt: twoHoursAgo,
    });

    const stale = state.getStaleOperations(30 * 60 * 1000);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe('stale-op');
  });

  it('ignores recent running operations', () => {
    state.logOperation({
      id: 'recent-op', type: 'deploy', target: 'app', status: 'running',
      startedAt: new Date().toISOString(),
    });

    const stale = state.getStaleOperations(30 * 60 * 1000);
    expect(stale).toHaveLength(0);
  });

  it('ignores completed operations', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.logOperation({
      id: 'done-op', type: 'deploy', target: 'app', status: 'completed',
      startedAt: twoHoursAgo,
    });

    const stale = state.getStaleOperations(30 * 60 * 1000);
    expect(stale).toHaveLength(0);
  });
});

// ── Agent meta ────────────────────────────────────────────────────────────

describe('Agent meta', () => {
  it('creates agent.yaml on init', () => {
    const meta = state.getAgentMeta();
    expect(meta).toBeDefined();
    expect(meta!.lastStartedAt).toBeTruthy();
  });

  it('preserves installedAt across restarts', () => {
    const meta1 = state.getAgentMeta();

    const state2 = new StateManager(tmpDir);
    state2.init();
    const meta2 = state2.getAgentMeta();

    expect(meta2!.installedAt).toBe(meta1!.installedAt);
  });
});
