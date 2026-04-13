// ── Config Tests ────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean agent-related env vars
    delete process.env.AGENT_PORT;
    delete process.env.AGENT_HOST;
    delete process.env.AGENT_TOKEN;
    delete process.env.STATE_PATH;
    delete process.env.LOG_LEVEL;
    delete process.env.RATE_LIMIT_MAX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns sensible defaults when no config file or env vars', () => {
    const config = loadConfig();

    expect(config.port).toBe(3100);
    expect(config.host).toBe('0.0.0.0');
    expect(config.authToken).toBe(''); // no token = server.ts will exit
    expect(config.statePath).toBe('/var/lib/platform');
    expect(config.logLevel).toBe('info');
    expect(config.rateLimitMax).toBe(100);
  });

  it('env vars override defaults', () => {
    process.env.AGENT_PORT = '9999';
    process.env.AGENT_HOST = '127.0.0.1';
    process.env.AGENT_TOKEN = 'env-token';
    process.env.STATE_PATH = '/tmp/test-state';
    process.env.LOG_LEVEL = 'debug';
    process.env.RATE_LIMIT_MAX = '50';

    const config = loadConfig();

    expect(config.port).toBe(9999);
    expect(config.host).toBe('127.0.0.1');
    expect(config.authToken).toBe('env-token');
    expect(config.statePath).toBe('/tmp/test-state');
    expect(config.logLevel).toBe('debug');
    expect(config.rateLimitMax).toBe(50);
  });

  it('ignores invalid log level and falls back to info', () => {
    process.env.LOG_LEVEL = 'banana';
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
  });

  it('ignores non-numeric port and falls back to default', () => {
    process.env.AGENT_PORT = 'not-a-number';
    const config = loadConfig();
    expect(config.port).toBe(3100);
  });

  it('version is a string', () => {
    const config = loadConfig();
    expect(typeof config.version).toBe('string');
  });
});
