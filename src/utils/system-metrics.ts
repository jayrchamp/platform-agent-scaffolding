// ── System Metrics Reader ───────────────────────────────────────────────────
//
// Reads CPU, RAM, disk, network, processes, and uptime from /proc and /sys.
// Linux-only (Ubuntu on Droplet). No external dependencies.
//
// All readers are async for consistency, even though most are sync fs reads.

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

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

/** Previous CPU sample for delta calculation */
let prevCpuIdle = 0;
let prevCpuTotal = 0;

export function readCpuMetrics(): CpuMetrics {
  const stat = readFileSync('/proc/stat', 'utf-8');
  const cpuLine = stat.split('\n')[0]!; // "cpu  user nice system idle iowait irq softirq steal"
  const parts = cpuLine.split(/\s+/).slice(1).map(Number);

  const idle = parts[3]! + (parts[4] ?? 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);

  // Delta since last read
  const deltaIdle = idle - prevCpuIdle;
  const deltaTotal = total - prevCpuTotal;

  prevCpuIdle = idle;
  prevCpuTotal = total;

  const usagePercent = deltaTotal > 0
    ? Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10
    : 0;

  // Core count
  const coreLines = stat.split('\n').filter(l => /^cpu\d+/.test(l));

  // Load average
  const loadAvg = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);

  return {
    usagePercent,
    cores: coreLines.length,
    loadAverage: [
      parseFloat(loadAvg[0]!),
      parseFloat(loadAvg[1]!),
      parseFloat(loadAvg[2]!),
    ],
  };
}

// ── Memory ─────────────────────────────────────────────────────────────────

export function readMemoryMetrics(): MemoryMetrics {
  const meminfo = readFileSync('/proc/meminfo', 'utf-8');
  const values: Record<string, number> = {};

  for (const line of meminfo.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) {
      values[match[1]!] = parseInt(match[2]!, 10); // in kB
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
    const output = execSync("df -BG / | tail -1", { encoding: 'utf-8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    // Fields: Filesystem 1G-blocks Used Available Use% Mounted
    const totalGb = parseInt(parts[1]!, 10) || 0;
    const usedGb = parseInt(parts[2]!, 10) || 0;
    const freeGb = parseInt(parts[3]!, 10) || 0;
    const usagePercent = parseInt(parts[4]!, 10) || 0;

    return { totalGb, usedGb, freeGb, usagePercent, mountPoint: '/' };
  } catch {
    return { totalGb: 0, usedGb: 0, freeGb: 0, usagePercent: 0, mountPoint: '/' };
  }
}

// ── Network ────────────────────────────────────────────────────────────────

export function readNetworkMetrics(): NetworkMetrics[] {
  const netDev = readFileSync('/proc/net/dev', 'utf-8');
  const lines = netDev.split('\n').slice(2); // skip headers
  const results: NetworkMetrics[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [iface, rest] = trimmed.split(':');
    if (!iface || !rest) continue;

    const name = iface.trim();
    // Skip loopback
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
    // ps with sorted output — most reliable cross-distro approach
    const output = execSync(
      `ps aux --sort=-%cpu | head -${limit + 1}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    const lines = output.trim().split('\n').slice(1); // skip header

    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1]!, 10),
        name: parts.slice(10).join(' '), // command
        cpuPercent: parseFloat(parts[2]!) || 0,
        memoryMb: parseFloat(parts[5]!) / 1024 || 0, // RSS in KB → MB
        user: parts[0]!,
      };
    });
  } catch {
    return [];
  }
}

// ── Uptime ─────────────────────────────────────────────────────────────────

export function readUptime(): UptimeInfo {
  const raw = readFileSync('/proc/uptime', 'utf-8').trim();
  const uptimeSeconds = Math.floor(parseFloat(raw.split(' ')[0]!));

  const loadAvgRaw = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);

  // Boot time
  const bootTimestamp = Date.now() - uptimeSeconds * 1000;

  return {
    uptimeSeconds,
    uptimeFormatted: formatUptime(uptimeSeconds),
    loadAverage: [
      parseFloat(loadAvgRaw[0]!),
      parseFloat(loadAvgRaw[1]!),
      parseFloat(loadAvgRaw[2]!),
    ],
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
