// ── Boot Cleanup Service ────────────────────────────────────────────────────
//
// Runs at agent startup to clean up stale state:
// 1. Detects operations marked 'running' with timestamp > 30min → marks failed
// 2. Removes stale lock files in /var/lib/platform/locks/
// 3. Logs all cleanup actions
//
// Called from server.ts after buildApp() but before listen().

import { existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StateManager } from './state.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CleanupResult {
  staleOperations: number;
  staleLocks: number;
  actions: string[];
}

// ── Main ───────────────────────────────────────────────────────────────────

export function runBootCleanup(
  stateManager: StateManager,
  basePath: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): CleanupResult {
  const log = logger ?? { info: console.log, warn: console.warn };
  const result: CleanupResult = { staleOperations: 0, staleLocks: 0, actions: [] };

  // ── 1. Stale operations (running > 30 min) ─────────────────────────────

  const staleOps = stateManager.getStaleOperations(30 * 60 * 1000);

  for (const op of staleOps) {
    const msg = `Marked stale operation ${op.id} (${op.type} on ${op.target}) as failed — started at ${op.startedAt}`;
    stateManager.markOperationFailed(op.id, 'Agent restarted — operation timed out');
    log.warn(msg);
    result.actions.push(msg);
    result.staleOperations++;
  }

  // ── 2. Stale lock files ────────────────────────────────────────────────

  const locksDir = join(basePath, 'locks');
  mkdirSync(locksDir, { recursive: true });

  if (existsSync(locksDir)) {
    const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith('.lock'));

    for (const lockFile of lockFiles) {
      const lockPath = join(locksDir, lockFile);
      try {
        unlinkSync(lockPath);
        const msg = `Removed stale lock file: ${lockFile}`;
        log.info(msg);
        result.actions.push(msg);
        result.staleLocks++;
      } catch {
        log.warn(`Failed to remove lock file: ${lockFile}`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────

  if (result.staleOperations > 0 || result.staleLocks > 0) {
    log.info(
      `Boot cleanup: ${result.staleOperations} stale operation(s), ${result.staleLocks} lock(s) removed`,
    );
  } else {
    log.info('Boot cleanup: nothing to clean up');
  }

  return result;
}
