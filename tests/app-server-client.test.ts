// ── App Server Client Tests ─────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpAppServerClient } from '../src/services/app-server-client.js';
import type { AppServerConfig } from '../src/config.js';

const mockServer: AppServerConfig = {
  host: '10.114.0.2',
  port: 3100,
  name: 'my-app-vps',
};

describe('HttpAppServerClient', () => {
  let client: HttpAppServerClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new HttpAppServerClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('ping', () => {
    it('returns reachable with version on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', version: '3.0.0' }),
      });

      const result = await client.ping(mockServer, 'test-token');

      expect(result.reachable).toBe(true);
      expect(result.version).toBe('3.0.0');
      expect(result.error).toBeUndefined();
    });

    it('returns unreachable with error on failure', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      const result = await client.ping(mockServer, 'test-token');

      expect(result.reachable).toBe(false);
      expect(result.error).toBe('Connection refused');
      expect(result.version).toBeUndefined();
    });

    it('returns unreachable on HTTP error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await client.ping(mockServer, 'wrong-token');

      expect(result.reachable).toBe(false);
      expect(result.error).toContain('401');
    });
  });

  describe('fetch', () => {
    it('sends authorization header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });
      globalThis.fetch = mockFetch;

      await client.fetch(mockServer, '/api/test', { authToken: 'my-token' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://10.114.0.2:3100/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        })
      );
    });

    it('throws on HTTP error response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        client.fetch(mockServer, '/api/test', { authToken: 'token' })
      ).rejects.toThrow('HTTP 500');
    });

    it('sends POST body as JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      globalThis.fetch = mockFetch;

      await client.fetch(mockServer, '/api/data', {
        method: 'POST',
        authToken: 'token',
        body: { key: 'value' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://10.114.0.2:3100/api/data',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        })
      );
    });

    it('aborts on timeout', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      );

      await expect(
        client.fetch(mockServer, '/slow', {
          authToken: 'token',
          timeoutMs: 1,
        })
      ).rejects.toThrow();
    });
  });
});
