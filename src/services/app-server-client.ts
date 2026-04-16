// ── App Server Client ───────────────────────────────────────────────────────
//
// HTTP client for worker agents to communicate with VPS App agents via VPC.
// Used for connectivity checks and cross-agent API calls.

import type { AppServerConfig } from '../config.js';

export interface AppServerClient {
  ping(
    server: AppServerConfig,
    authToken: string
  ): Promise<{ reachable: boolean; version?: string; error?: string }>;

  fetch<T>(
    server: AppServerConfig,
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      authToken: string;
      timeoutMs?: number;
    }
  ): Promise<T>;
}

export class HttpAppServerClient implements AppServerClient {
  async ping(
    server: AppServerConfig,
    authToken: string
  ): Promise<{ reachable: boolean; version?: string; error?: string }> {
    try {
      const res = await this.fetch<{ status: string; version: string }>(
        server,
        '/health',
        { authToken, timeoutMs: 5000 }
      );
      return { reachable: true, version: res.version };
    } catch (err) {
      return {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async fetch<T>(
    server: AppServerConfig,
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      authToken: string;
      timeoutMs?: number;
    }
  ): Promise<T> {
    const url = `http://${server.host}:${server.port}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 10000
    );

    try {
      const res = await globalThis.fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          'Content-Type': 'application/json',
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
