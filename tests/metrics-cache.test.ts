// ── Metrics Cache Tests ─────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedMetrics,
  getCachedProcesses,
  getCachedUptime,
  resetCache,
} from '../src/utils/metrics-cache.js';

beforeEach(() => {
  resetCache();
});

describe('getCachedMetrics', () => {
  it('returns system metrics on first call', () => {
    const m = getCachedMetrics();
    expect(m.cpu).toBeDefined();
    expect(m.memory).toBeDefined();
    expect(m.disk).toBeDefined();
    expect(m.network).toBeDefined();
  });

  it('returns same reference on rapid successive calls (cached)', () => {
    const m1 = getCachedMetrics();
    const m2 = getCachedMetrics();
    // Should be the same object (served from cache)
    expect(m1).toBe(m2);
  });
});

describe('getCachedProcesses', () => {
  it('returns process list', () => {
    const procs = getCachedProcesses(5);
    expect(Array.isArray(procs)).toBe(true);
    expect(procs.length).toBeGreaterThan(0);
  });

  it('returns same reference on rapid successive calls (cached)', () => {
    const p1 = getCachedProcesses();
    const p2 = getCachedProcesses();
    expect(p1).toBe(p2);
  });
});

describe('getCachedUptime', () => {
  it('returns uptime info', () => {
    const u = getCachedUptime();
    expect(u.uptimeSeconds).toBeGreaterThan(0);
    expect(typeof u.uptimeFormatted).toBe('string');
  });
});

describe('resetCache', () => {
  it('clears cached data so next call fetches fresh', () => {
    const m1 = getCachedMetrics();
    resetCache();
    const m2 = getCachedMetrics();
    // After reset, should be a new object
    expect(m1).not.toBe(m2);
  });
});
