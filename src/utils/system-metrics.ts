// ── System Metrics Reader ───────────────────────────────────────────────────
//
// Reads CPU, RAM, disk, network, processes, and uptime from /proc and /sys.
// Primary target: Linux (Ubuntu on Droplet).
// On non-Linux (macOS dev), returns safe fallback values so the agent still starts.
//
// All readers are sync for simplicity (called from cache layer).

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform as osPlatform, cpus, totalmem, freemem, uptime as osUptime, loadavg } from 'node:os';

// ── Platform detection ─────────────────────────────────────────────────────

const IS_LINUX = osPlatform() === 'linux';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  network: NetworkMetrics[];
}

export interface CpuMetrics {
  /** Overall CPU usage percentage (0-100) */
  usagePercent: number;
  /** Per-core usage if available */
  cores: number;
  /** 1/5/15 min load averages */
  loadAverage: [number, number, number];
}

export interface MemoryMetrics {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  availableMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
}

export interface DiskMetrics {
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usagePercent: number;
  /** Mount point measured (always /) */
  mountPoint: string;
}

export interface NetworkMetrics {
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
  user: string;
}

export interface UptimeInfo {
  /** System uptime in seconds */
  uptimeSeconds: number;
  /** Formatted uptime string (e.g. "3d 4h 12m") */
  uptimeFormatted: string;
  /** 1/5/15 min load averages */
  loadAverage: [number, number, number];
  /** Boot time ISO string */
  bootTime: string;
}

// ── CPU ────────────────────────────────────────────────────────────────────

/** Previous CPU sample for delta calculation (Linux only) */
let prevCpuIdle = 0;
let prevCpuTotal = 0;

export function readCpuMetrics(): CpuMetrics {
  if (!IS_LINUX) {
    // macOS fallback: use os module (less precise but functional)
    const avg = loadavg() as [number, number, number];
    return {
      usagePercent: 0, // can't reliably compute from os module
      cores: cpus().length,
      loadAverage: avg,
    };
  }

  const stat = readFileSync('/proc/stat', 'utf-8');
  const cpuLine = stat.split('\n')[0]!;
  const parts = cpuLine.split(/\s+/).slice(1).map(Number);

  const idle = parts[3]! + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);

  const deltaIdle = idle - prevCpuIdle;
  const deltaTotal = total - prevCpuTotal;

  prevCpuIdle = idle;
  prevCpuTotal = total;

  const usagePercent = deltaTotal > 0
    ? Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10
    : 0;

  const coreLines = stat.split('\n').filter(l => /^cpu\d+/.test(l));
  const loadAvgLine = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);

  return {
    usagePercent,
    cores: coreLines.length,
    loadAverage: [
      parseFloat(loadAvgLine[0]!),
      parseFloat(loadAvgLine[1]!),
      parseFloat(loadAvgLine[2]!),
    ],
  };
}

// ── Memory ─────────────────────────────────────────────────────────────────

export function readMemoryMetrics(): MemoryMetrics {
  if (!IS_LINUX) {
    // macOS fallback
    const totalMb = Math.round(totalmem() / 1024 / 1024);
    const freeMb = Math.round(freemem() / 1024 / 1024);
    const usedMb = totalMb - freeMb;
    return {
      totalMb,
      usedMb,
      freeMb,
      availableMb: freeMb,
      usagePercent: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0,
      swapTotalMb: 0,
      swapUsedMb: 0,
    };
  }

  const meminfo = readFileSync('/proc/meminfo', 'utf-8');
  const values: Record<string, number> = {};

  for (const line of meminfo.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) {
      values[match[1]!] = parseInt(match[2]!, 10);
    }
  }

  const totalKb = values['MemTotal'] ?? 0;
  const freeKb = values['MemFree'] ?? 0;
  const availableKb = values['MemAvailable'] ?? freeKb;
  const swapTotalKb = values['SwapTotal'] ?? 0;
  const swapFreeKb = values['SwapFree'] ?? 0;

  const totalMb = Math.round(totalKb / 1024);
  const usedMb = Math.round((totalKb - availableKb) / 1024);
  const freeMb = Math.round(freeKb / 1024);
  const availableMb = Math.round(availableKb / 1024);

  return {
    totalMb,
    usedMb,
    freeMb,
    availableMb,
    usagePercent: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0,
    swapTotalMb: Math.round(swapTotalKb / 1024),
    swapUsedMb: Math.round((swapTotalKb - swapFreeKb) / 1024),
  };
}

// ── Disk ───────────────────────────────────────────────────────────────────

export function readDiskMetrics(): DiskMetrics {
  try {
    // df -BG works on Linux; macOS uses df -g
    const cmd = IS_LINUX ? "df -BG / | tail -1" : "df -g / | tail -1";
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);

    if (IS_LINUX) {
      return {
        totalGb: parseInt(parts[1]!, 10) || 0,
        usedGb: parseInt(parts[2]!, 10) || 0,
        freeGb: parseInt(parts[3]!, 10) || 0,
        usagePercent: parseInt(parts[4]!, 10) || 0,
        mountPoint: '/',
      };
    } else {
      // macOS df -g: Filesystem Gblocks Used Available Capacity ...
      return {
        totalGb: parseInt(parts[1]!, 10) || 0,
        usedGb: parseInt(parts[2]!, 10) || 0,
        freeGb: parseInt(parts[3]!, 10) || 0,
        usagePercent: parseInt(parts[4]!, 10) || 0,
        mountPoint: '/',
      };
    }
  } catch {
    return { totalGb: 0, usedGb: 0, freeGb: 0, usagePercent: 0, mountPoint: '/' };
  }
}

// ── Network ────────────────────────────────────────────────────────────────

export function readNetworkMetrics(): NetworkMetrics[] {
  if (!IS_LINUX) {
    // No /proc/net/dev on macOS — return empty (network metrics are VPS-focused)
    return [];
  }

  const netDev = readFileSync('/proc/net/dev', 'utf-8');
  const lines = netDev.split('\n').slice(2);
  const results: NetworkMetrics[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [iface, rest] = trimmed.split(':');
    if (!iface || !rest) continue;

    const name = iface.trim();
    if (name === 'lo') continue;

    const values = rest.trim().split(/\s+/).map(Number);
    results.push({
      interface: name,
      rxBytes: values[0] ?? 0,
      txBytes: values[8] ?? 0,
      rxPackets: values[1] ?? 0,
      txPackets: values[9] ?? 0,
    });
  }

  return results;
}

// ── Processes ──────────────────────────────────────────────────────────────

export function readTopProcesses(limit = 10): ProcessInfo[] {
  try {
    // macOS ps doesn't support --sort, use different syntax
    const cmd = IS_LINUX
      ? `ps aux --sort=-%cpu | head -${limit + 1}`
      : `ps aux -r | head -${limit + 1}`;

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n').slice(1);

    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1]!, 10),
        name: parts.slice(10).join(' '),
        cpuPercent: parseFloat(parts[2]!) || 0,
        memoryMb: parseFloat(parts[5]!) / 1024 || 0,
        user: parts[0]!,
      };
    });
  } catch {
    return [];
  }
}

// ── Uptime ─────────────────────────────────────────────────────────────────

export function readUptime(): UptimeInfo {
  let uptimeSeconds: number;

  if (IS_LINUX && existsSync('/proc/uptime')) {
    const raw = readFileSync('/proc/uptime', 'utf-8').trim();
    uptimeSeconds = Math.floor(parseFloat(raw.split(' ')[0]!));
  } else {
    // macOS fallback
    uptimeSeconds = Math.floor(osUptime());
  }

  const avg = IS_LINUX && existsSync('/proc/loadavg')
    ? readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/).map(parseFloat)
    : loadavg();

  const bootTimestamp = Date.now() - uptimeSeconds * 1000;

  return {
    uptimeSeconds,
    uptimeFormatted: formatUptime(uptimeSeconds),
    loadAverage: [avg[0]!, avg[1]!, avg[2]!] as [number, number, number],
    bootTime: new Date(bootTimestamp).toISOString(),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

// ── All metrics combined ───────────────────────────────────────────────────

export function readAllMetrics(): SystemMetrics {
  return {
    cpu: readCpuMetrics(),
    memory: readMemoryMetrics(),
    disk: readDiskMetrics(),
    network: readNetworkMetrics(),
  };
}
