// ── Network Service Tests ─────────────────────────────────────────────────────
//
// Tests for the iptables-based IP blocking/unblocking service.
// The execFile calls are mocked so no actual iptables commands are run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock child_process ───────────────────────────────────────────────────────

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    // The service uses promisify(execFile), which expects the callback form.
    // We expose mockExecFile so tests can set up return values.
    const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    // Schedule async to match real behavior
    Promise.resolve(mockExecFile(...args.slice(0, -1))).then(
      (result) => callback(null, result ?? { stdout: '', stderr: '' }),
      (err) => callback(err as Error, { stdout: '', stderr: '' }),
    );
  },
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { blockIp, unblockIp, checkIpBlockStatus } from '../src/services/network.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns mock stdout for `iptables -L INPUT --line-numbers -n` with a DROP rule */
function makeIptablesListWithBlock(ip: string): string {
  return [
    'Chain INPUT (policy ACCEPT)',
    'num  target     prot opt source               destination',
    `1    ACCEPT     tcp  --  0.0.0.0/0            ${ip}          tcp dpt:22 /* platform-manager-block */`,
    `2    DROP       all  --  0.0.0.0/0            ${ip}          /* platform-manager-block */`,
  ].join('\n');
}

function makeEmptyIptablesList(): string {
  return [
    'Chain INPUT (policy ACCEPT)',
    'num  target     prot opt source               destination',
  ].join('\n');
}

// ── Tests: isValidPublicIp (indirectly via blockIp rejection) ─────────────────

describe('blockIp — input validation', () => {
  it('rejects private 10.x.x.x addresses', async () => {
    await expect(blockIp('10.0.0.1')).rejects.toThrow();
  });

  it('rejects private 192.168.x.x addresses', async () => {
    await expect(blockIp('192.168.1.1')).rejects.toThrow();
  });

  it('rejects loopback 127.x.x.x', async () => {
    await expect(blockIp('127.0.0.1')).rejects.toThrow();
  });

  it('accepts public IPs', async () => {
    // Mock successful iptables calls + persist
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    const result = await blockIp('142.93.25.10');
    expect(result.success).toBe(true);
  });
});

// ── Tests: blockIp ────────────────────────────────────────────────────────────

describe('blockIp', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('returns success and descriptive message', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await blockIp('142.93.25.10');

    expect(result.success).toBe(true);
    expect(result.message).toContain('142.93.25.10');
    expect(result.message).toContain('22');
  });

  it('includes SSH port in success message', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await blockIp('142.93.25.10');

    expect(result.message).toMatch(/SSH port 22/i);
  });

  it('adds an extra ACCEPT rule for agentPort when provided', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    await blockIp('142.93.25.10', 3000);

    // Should have been called with -I INPUT 2 for the agent port
    const calls = mockExecFile.mock.calls as string[][];
    const agentPortCall = calls.find(
      (args) => args.includes('3000') && args.includes('ACCEPT'),
    );
    expect(agentPortCall).toBeDefined();
  });

  it('calls iptables at least 3 times (ACCEPT SSH + DROP + persist attempt)', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    await blockIp('142.93.25.10');

    // At minimum: ACCEPT ssh, DROP all, netfilter-persistent or iptables-save
    expect(mockExecFile.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('attempts cleanup and rethrows when iptables fails', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ACCEPT SSH succeeds
      .mockRejectedValueOnce(new Error('iptables: Permission denied')); // DROP fails

    await expect(blockIp('142.93.25.10')).rejects.toThrow('Permission denied');
  });
});

// ── Tests: unblockIp ──────────────────────────────────────────────────────────

describe('unblockIp', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('reports no rules found when list is empty', async () => {
    // First call: LIST to find rules — returns empty
    mockExecFile.mockResolvedValue({ stdout: makeEmptyIptablesList(), stderr: '' });

    const result = await unblockIp('142.93.25.10');

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/no blocking rules|already unblocked/i);
  });

  it('returns success with removal count when rules exist', async () => {
    // Simulate: first list shows 2 rules, DELETE succeeds, second list shows none
    mockExecFile
      .mockResolvedValueOnce({ stdout: makeIptablesListWithBlock('142.93.25.10'), stderr: '' }) // LIST
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // DELETE line 2 (highest)
      .mockResolvedValueOnce({ stdout: makeEmptyIptablesList(), stderr: '' }) // LIST again → empty
      .mockResolvedValue({ stdout: '', stderr: '' }); // persist

    const result = await unblockIp('142.93.25.10');

    expect(result.success).toBe(true);
  });
});

// ── Tests: checkIpBlockStatus ─────────────────────────────────────────────────

describe('checkIpBlockStatus', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('returns "blocked" when a DROP rule with comment exists', async () => {
    mockExecFile.mockResolvedValue({ stdout: makeIptablesListWithBlock('142.93.25.10'), stderr: '' });

    const status = await checkIpBlockStatus('142.93.25.10');
    expect(status).toBe('blocked');
  });

  it('returns "accessible" when no DROP rule exists', async () => {
    mockExecFile.mockResolvedValue({ stdout: makeEmptyIptablesList(), stderr: '' });

    const status = await checkIpBlockStatus('142.93.25.10');
    expect(status).toBe('accessible');
  });

  it('returns "unknown" when iptables command fails', async () => {
    mockExecFile.mockRejectedValue(new Error('iptables: command not found'));

    const status = await checkIpBlockStatus('142.93.25.10');
    expect(status).toBe('unknown');
  });

  it('returns "accessible" for a different IP even if another is blocked', async () => {
    // The list has a block for 142.93.25.10, but we're checking 5.5.5.5
    mockExecFile.mockResolvedValue({ stdout: makeIptablesListWithBlock('142.93.25.10'), stderr: '' });

    const status = await checkIpBlockStatus('5.5.5.5');
    expect(status).toBe('accessible');
  });
});
