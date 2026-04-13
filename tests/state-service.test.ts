// ── State Service Tests ─────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// ── AppSpecs ───────────────────────────────────────────────────────────────

describe('AppSpec CRUD', () => {
  const baseSpec: AppSpec = {
    name: 'my-app',
    image: 'my-app:latest',
    desiredState: 'running',
    port: 3000,
    createdAt: '',
    updatedAt: '',
  };

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

  it('deletes an appspec', () => {
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

    // Create a new StateManager on the same path — simulates restart
    const state2 = new StateManager(tmpDir);
    state2.init();

    expect(state2.getAppSpec('my-app')).toBeDefined();
    expect(state2.getAppSpec('my-app')!.image).toBe('my-app:latest');
  });
});

// ── Operations log ─────────────────────────────────────────────────────────

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

// ── Stale operations ───────────────────────────────────────────────────────

describe('Stale operations', () => {
  it('detects operations running longer than maxAge', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.logOperation({
      id: 'stale-op', type: 'deploy', target: 'app', status: 'running',
      startedAt: twoHoursAgo,
    });

    const stale = state.getStaleOperations(30 * 60 * 1000); // 30 min
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

// ── Agent meta ─────────────────────────────────────────────────────────────

describe('Agent meta', () => {
  it('creates agent.yaml on init', () => {
    const meta = state.getAgentMeta();
    expect(meta).toBeDefined();
    expect(meta!.lastStartedAt).toBeTruthy();
  });

  it('preserves installedAt across restarts', () => {
    const meta1 = state.getAgentMeta();

    // Simulate restart
    const state2 = new StateManager(tmpDir);
    state2.init();
    const meta2 = state2.getAgentMeta();

    expect(meta2!.installedAt).toBe(meta1!.installedAt);
  });
});
