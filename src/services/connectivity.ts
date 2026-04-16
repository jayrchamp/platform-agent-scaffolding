// ── Connectivity Service ────────────────────────────────────────────────────
//
// TCP connectivity check for VPC inter-VPS communication.
// Used to verify that a VPS can reach a remote database server before deploy.

import * as net from 'net';

export interface ConnectivityResult {
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export function checkTcpConnectivity(
  host: string,
  port: number,
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Connection to ${host}:${port} timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export function classifyConnectivityError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException).code;

  if (message.includes('timed out')) return 'timeout';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'EHOSTUNREACH') return 'host_unreachable';
  if (code === 'ENETUNREACH') return 'network_unreachable';
  if (code === 'ENOTFOUND') return 'dns_not_found';

  return `unknown: ${message}`;
}
