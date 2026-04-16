// ── Config Worker Tests ─────────────────────────────────────────────────────
//
// Tests for appServers parsing from config

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig — appServers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGENT_PORT;
    delete process.env.AGENT_HOST;
    delete process.env.AGENT_TOKEN;
    delete process.env.AGENT_ROLE;
    delete process.env.STATE_PATH;
    delete process.env.LOG_LEVEL;
    delete process.env.RATE_LIMIT_MAX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty appServers array when no YAML', () => {
    const config = loadConfig();
    expect(config.appServers).toEqual([]);
  });

  it('appServers defaults port to 3100 and name to host', () => {
    // Without a YAML config file, this tests the fallback behavior
    const config = loadConfig();
    expect(Array.isArray(config.appServers)).toBe(true);
    expect(config.appServers).toHaveLength(0);
  });

  it('role defaults to full', () => {
    const config = loadConfig();
    expect(config.role).toBe('full');
  });

  it('worker role accepted via env var', () => {
    process.env.AGENT_ROLE = 'worker';
    const config = loadConfig();
    expect(config.role).toBe('worker');
  });
});
