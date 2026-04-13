// ── Boot Cleanup Tests ──────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../src/services/state.js';
import { runBootCleanup } from '../src/services/boot-cleanup.js';

let tmpDir: string;
let state: StateManager;

const silentLogger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-cleanup-'));
  state = new StateManager(tmpDir);
  state.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Stale operations cleanup', () => {
  it('marks operations running > 30min as failed', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.logOperation({
      id: 'stale-op-1',
      type: 'deploy',
      target: 'my-app',
      status: 'running',
      startedAt: twoHoursAgo,
    });

    const result = runBootCleanup(state, tmpDir, silentLogger);

    expect(result.staleOperations).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toContain('stale-op-1');
  });

  it('leaves recent running operations alone', () => {
    state.logOperation({
      id: 'recent-op',
      type: 'deploy',
      target: 'my-app',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const result = runBootCleanup(state, tmpDir, silentLogger);
    expect(result.staleOperations).toBe(0);
  });

  it('ignores completed operations', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.logOperation({
      id: 'done-op',
      type: 'deploy',
      target: 'my-app',
      status: 'completed',
      startedAt: twoHoursAgo,
    });

    const result = runBootCleanup(state, tmpDir, silentLogger);
    expect(result.staleOperations).toBe(0);
  });
});

describe('Lock file cleanup', () => {
  it('removes .lock files from locks directory', () => {
    const locksDir = join(tmpDir, 'locks');
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, 'my-app.lock'), 'locked', 'utf-8');
    writeFileSync(join(locksDir, 'db-resize.lock'), 'locked', 'utf-8');

    const result = runBootCleanup(state, tmpDir, silentLogger);

    expect(result.staleLocks).toBe(2);
    expect(existsSync(join(locksDir, 'my-app.lock'))).toBe(false);
    expect(existsSync(join(locksDir, 'db-resize.lock'))).toBe(false);
  });

  it('ignores non-lock files', () => {
    const locksDir = join(tmpDir, 'locks');
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, 'readme.txt'), 'not a lock', 'utf-8');

    const result = runBootCleanup(state, tmpDir, silentLogger);

    expect(result.staleLocks).toBe(0);
    expect(existsSync(join(locksDir, 'readme.txt'))).toBe(true);
  });
});

describe('Clean state', () => {
  it('reports nothing to clean when state is clean', () => {
    const result = runBootCleanup(state, tmpDir, silentLogger);

    expect(result.staleOperations).toBe(0);
    expect(result.staleLocks).toBe(0);
    expect(result.actions).toHaveLength(0);
  });
});
