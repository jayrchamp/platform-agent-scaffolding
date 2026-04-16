// ── Connectivity Service Tests ──────────────────────────────────────────────
//
// Unit tests for TCP connectivity check and error classification.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'net';
import {
  checkTcpConnectivity,
  classifyConnectivityError,
} from '../src/services/connectivity.js';

describe('checkTcpConnectivity', () => {
  it('resolves when connection succeeds', async () => {
    // Create a local TCP server to connect to
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const port = (server.address() as net.AddressInfo).port;

    try {
      await expect(
        checkTcpConnectivity('127.0.0.1', port, 2000)
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('rejects with ECONNREFUSED when port is closed', async () => {
    // Use a port that is very unlikely to be open
    await expect(
      checkTcpConnectivity('127.0.0.1', 59999, 2000)
    ).rejects.toThrow();
  });

  it('rejects with timeout when host is unreachable', async () => {
    // Use a non-routable IP to trigger timeout (very short timeout)
    await expect(checkTcpConnectivity('192.0.2.1', 5432, 100)).rejects.toThrow(
      'timed out'
    );
  });
});

describe('classifyConnectivityError', () => {
  it('classifies ECONNREFUSED', () => {
    const err = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    expect(classifyConnectivityError(err)).toBe('connection_refused');
  });

  it('classifies EHOSTUNREACH', () => {
    const err = new Error('host unreachable') as NodeJS.ErrnoException;
    err.code = 'EHOSTUNREACH';
    expect(classifyConnectivityError(err)).toBe('host_unreachable');
  });

  it('classifies ENETUNREACH', () => {
    const err = new Error('network unreachable') as NodeJS.ErrnoException;
    err.code = 'ENETUNREACH';
    expect(classifyConnectivityError(err)).toBe('network_unreachable');
  });

  it('classifies ENOTFOUND', () => {
    const err = new Error('DNS not found') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    expect(classifyConnectivityError(err)).toBe('dns_not_found');
  });

  it('classifies timeout', () => {
    const err = new Error('Connection timed out after 5000ms');
    expect(classifyConnectivityError(err)).toBe('timeout');
  });

  it('classifies unknown errors', () => {
    const err = new Error('something weird');
    expect(classifyConnectivityError(err)).toBe('unknown: something weird');
  });

  it('handles non-Error values', () => {
    expect(classifyConnectivityError('oops')).toBe('unknown: oops');
  });
});
