// ── Network Service (iptables) ───────────────────────────────────────────────
//
// Applies and removes iptables rules to block/unblock inbound traffic on a
// given IP address. Used to make the original droplet IP inaccessible from the
// public internet when a DigitalOcean Reserved IP is in use.
//
// Strategy:
//   - We add rules to the INPUT chain that DROP traffic arriving on the
//     original IP, with explicit ACCEPT rules first for critical ports (22 for
//     SSH, and the agent's own port) so we can never lock ourselves out.
//   - Rules are persisted via iptables-save / iptables-restore so they survive
//     a container restart. (systemd iptables-persistent on Ubuntu handles this.)
//   - Rules are tagged with a comment so we can cleanly identify and remove them.

import { execFile as execFileCb } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const RULE_COMMENT = 'platform-manager-block';
const SSH_PORT = 22;

// ── Public API ───────────────────────────────────────────────────────────────

export interface NetworkOpResult {
  success: boolean;
  message: string;
}

/**
 * Block all inbound TCP/UDP traffic on `ip`, except SSH (port 22) and the
 * optional `agentPort`. Uses iptables with a comment tag so rules can be
 * cleanly removed later.
 */
export async function blockIp(
  ip: string,
  agentPort?: number,
): Promise<NetworkOpResult> {
  try {
    // 1. ACCEPT SSH first (safety: can never lock ourselves out)
    await iptablesRun([
      '-I', 'INPUT', '1',
      '-d', ip,
      '-p', 'tcp',
      '--dport', String(SSH_PORT),
      '-j', 'ACCEPT',
      '-m', 'comment', '--comment', RULE_COMMENT,
    ]);

    // 2. ACCEPT agent port if provided
    if (agentPort) {
      await iptablesRun([
        '-I', 'INPUT', '2',
        '-d', ip,
        '-p', 'tcp',
        '--dport', String(agentPort),
        '-j', 'ACCEPT',
        '-m', 'comment', '--comment', RULE_COMMENT,
      ]);
    }

    // 3. DROP everything else inbound on this IP
    await iptablesRun([
      '-A', 'INPUT',
      '-d', ip,
      '-j', 'DROP',
      '-m', 'comment', '--comment', RULE_COMMENT,
    ]);

    // 4. Persist rules so they survive reboots
    await persistRules();

    return {
      success: true,
      message: `Blocked inbound traffic on ${ip} (SSH port ${SSH_PORT} remains open)`,
    };
  } catch (err) {
    // Best-effort cleanup: try to remove any rules we may have added
    await unblockIp(ip).catch(() => {});
    throw err;
  }
}

/**
 * Remove all iptables rules tagged with our comment for the given IP.
 */
export async function unblockIp(ip: string): Promise<NetworkOpResult> {
  let removed = 0;
  let continueRemoving = true;

  // iptables doesn't support removing by comment directly;
  // we loop: list rules with line numbers, find ours, delete by number (highest first),
  // repeat until none left.
  while (continueRemoving) {
    continueRemoving = false;

    let ruleNumbers: number[];
    try {
      ruleNumbers = await findRulesByCommentAndIp(ip);
    } catch {
      break;
    }

    if (ruleNumbers.length === 0) break;

    // Delete from highest line number downward to avoid re-numbering issues
    for (const lineNum of ruleNumbers.sort((a, b) => b - a)) {
      try {
        await iptablesRun(['-D', 'INPUT', String(lineNum)]);
        removed++;
        continueRemoving = true; // loop again — line numbers shifted
        break; // restart the outer while loop
      } catch {
        // Rule may have already been removed
      }
    }
  }

  await persistRules();

  return {
    success: true,
    message: removed > 0
      ? `Removed ${removed} iptables rule(s) for ${ip}. Original IP is now accessible.`
      : `No blocking rules found for ${ip}. Already unblocked.`,
  };
}

/**
 * Check whether blocking rules exist for the given IP.
 * Returns 'blocked', 'accessible', or 'unknown'.
 */
export async function checkIpBlockStatus(
  ip: string,
): Promise<'blocked' | 'accessible' | 'unknown'> {
  try {
    const hasDropRule = await hasDropRuleForIp(ip);
    return hasDropRule ? 'blocked' : 'accessible';
  } catch {
    return 'unknown';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function iptablesRun(args: string[]): Promise<string> {
  const { stdout } = await execFile('iptables', args);
  return stdout;
}

/**
 * List line numbers of INPUT rules tagged with our comment and targeting `ip`.
 */
async function findRulesByCommentAndIp(ip: string): Promise<number[]> {
  const { stdout } = await execFile('iptables', ['-L', 'INPUT', '--line-numbers', '-n']);
  const lines = stdout.split('\n');
  const result: number[] = [];

  for (const line of lines) {
    if (line.includes(RULE_COMMENT) && line.includes(ip)) {
      const match = /^(\d+)/.exec(line.trim());
      if (match) {
        result.push(parseInt(match[1], 10));
      }
    }
  }

  return result;
}

/**
 * Check whether a DROP rule exists for the given destination IP.
 */
async function hasDropRuleForIp(ip: string): Promise<boolean> {
  const { stdout } = await execFile('iptables', ['-L', 'INPUT', '-n']);
  const lines = stdout.split('\n');
  return lines.some(
    (line) => line.includes('DROP') && line.includes(ip) && line.includes(RULE_COMMENT),
  );
}

/**
 * Persist current iptables rules to survive reboots.
 * Works on Ubuntu/Debian with iptables-persistent installed.
 * Silently no-ops if the tool isn't available.
 */
async function persistRules(): Promise<void> {
  try {
    // Try netfilter-persistent (Ubuntu 22.04+)
    await execFile('netfilter-persistent', ['save']);
  } catch {
    try {
      // Fallback: iptables-save to the standard location
      const { stdout } = await execFile('iptables-save');
      await writeFile('/etc/iptables/rules.v4', stdout, 'utf-8');
    } catch {
      // Neither tool available — rules are in memory only (lost on reboot)
      // This is acceptable; the UI will show "unknown" status after reboot
    }
  }
}
