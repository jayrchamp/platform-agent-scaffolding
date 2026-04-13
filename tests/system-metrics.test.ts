// ── System Metrics Tests ────────────────────────────────────────────────────
//
// These tests run on Linux (same as production). They read real /proc data.

import { describe, it, expect } from 'vitest';
import {
  readCpuMetrics,
  readMemoryMetrics,
  readDiskMetrics,
  readNetworkMetrics,
  readTopProcesses,
  readUptime,
  readAllMetrics,
} from '../src/utils/system-metrics.js';

describe('readCpuMetrics', () => {
  it('returns valid CPU metrics', () => {
    // First call initializes the baseline
    readCpuMetrics();
    // Second call gets a delta
    const cpu = readCpuMetrics();

    expect(cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(cpu.cores).toBeGreaterThan(0);
    expect(cpu.loadAverage).toHaveLength(3);
    cpu.loadAverage.forEach((v) => expect(typeof v).toBe('number'));
  });
});

describe('readMemoryMetrics', () => {
  it('returns valid memory metrics', () => {
    const mem = readMemoryMetrics();

    expect(mem.totalMb).toBeGreaterThan(0);
    expect(mem.usedMb).toBeGreaterThanOrEqual(0);
    expect(mem.freeMb).toBeGreaterThanOrEqual(0);
    expect(mem.availableMb).toBeGreaterThanOrEqual(0);
    expect(mem.usagePercent).toBeGreaterThanOrEqual(0);
    expect(mem.usagePercent).toBeLessThanOrEqual(100);
    expect(mem.swapTotalMb).toBeGreaterThanOrEqual(0);
    expect(mem.swapUsedMb).toBeGreaterThanOrEqual(0);
    // Used + available should roughly equal total (within margin)
    expect(mem.usedMb + mem.availableMb).toBeCloseTo(mem.totalMb, -2);
  });
});

describe('readDiskMetrics', () => {
  it('returns valid disk metrics for /', () => {
    const disk = readDiskMetrics();

    expect(disk.mountPoint).toBe('/');
    expect(disk.totalGb).toBeGreaterThan(0);
    expect(disk.usedGb).toBeGreaterThanOrEqual(0);
    expect(disk.freeGb).toBeGreaterThanOrEqual(0);
    expect(disk.usagePercent).toBeGreaterThanOrEqual(0);
    expect(disk.usagePercent).toBeLessThanOrEqual(100);
  });
});

describe('readNetworkMetrics', () => {
  it('returns an array of interfaces (excluding lo)', () => {
    const nets = readNetworkMetrics();

    expect(Array.isArray(nets)).toBe(true);
    // Should have at least one interface (eth0, ens3, etc.)
    // In some containers there might be none — so just check structure
    for (const net of nets) {
      expect(net.interface).toBeTruthy();
      expect(net.interface).not.toBe('lo');
      expect(typeof net.rxBytes).toBe('number');
      expect(typeof net.txBytes).toBe('number');
      expect(typeof net.rxPackets).toBe('number');
      expect(typeof net.txPackets).toBe('number');
    }
  });
});

describe('readTopProcesses', () => {
  it('returns an array of processes', () => {
    const procs = readTopProcesses(5);

    expect(Array.isArray(procs)).toBe(true);
    expect(procs.length).toBeGreaterThan(0);
    expect(procs.length).toBeLessThanOrEqual(5);

    for (const proc of procs) {
      expect(typeof proc.pid).toBe('number');
      expect(proc.pid).toBeGreaterThan(0);
      expect(typeof proc.name).toBe('string');
      expect(typeof proc.cpuPercent).toBe('number');
      expect(typeof proc.memoryMb).toBe('number');
      expect(typeof proc.user).toBe('string');
    }
  });
});

describe('readUptime', () => {
  it('returns valid uptime info', () => {
    const uptime = readUptime();

    expect(uptime.uptimeSeconds).toBeGreaterThan(0);
    expect(typeof uptime.uptimeFormatted).toBe('string');
    expect(uptime.uptimeFormatted.length).toBeGreaterThan(0);
    expect(uptime.loadAverage).toHaveLength(3);
    expect(typeof uptime.bootTime).toBe('string');
    // bootTime should be a valid ISO date
    expect(new Date(uptime.bootTime).getTime()).toBeGreaterThan(0);
  });
});

describe('readAllMetrics', () => {
  it('returns combined metrics object', () => {
    const all = readAllMetrics();

    expect(all.cpu).toBeDefined();
    expect(all.memory).toBeDefined();
    expect(all.disk).toBeDefined();
    expect(all.network).toBeDefined();
    expect(Array.isArray(all.network)).toBe(true);
  });
});
