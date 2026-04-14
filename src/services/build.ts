// ── Build Service ───────────────────────────────────────────────────────────
//
// Handles git clone/pull and Docker image builds from Dockerfile.
// Build artifacts are stored in /var/lib/platform/builds/<appName>/.
//
// Flow:
//   1. cloneOrPull() — ensure repo is cloned and at the right ref
//   2. buildImage() — docker build from the repo's Dockerfile
//   3. Returns the local image tag (e.g. app-myapp:v3)

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const exec = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────────────

let BUILDS_BASE = '/var/lib/platform/builds';

/** Set the builds base directory (called at agent boot from config.statePath) */
export function setBuildsBase(statePath: string): void {
  BUILDS_BASE = path.join(statePath, 'builds');
}

// ── Build log helpers ───────────────────────────────────────────────────────

/** Returns the path to the build log file for an app */
export function getBuildLogPath(appName: string): string {
  return path.join(BUILDS_BASE, appName, 'build.log');
}

/** Clears (truncates) the build log for an app, creating the directory if needed */
export function clearBuildLog(appName: string): void {
  const logPath = getBuildLogPath(appName);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');
}

/**
 * Run a command and append its stdout+stderr to a log file.
 * Prefixes each command with a timestamp header line.
 */
async function runCommandWithLog(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
  logPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const ts = new Date().toISOString();
    logStream.write(`\n[${ts}] $ ${cmd} ${args.join(' ')}\n`);

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout,
    });

    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    child.on('error', (err) => {
      logStream.write(`\n[spawn error] ${err.message}\n`);
      logStream.end();
      reject(err);
    });

    child.on('close', (code) => {
      logStream.write(`\n[exit code: ${code ?? 'null'}]\n`);
      logStream.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command '${cmd} ${args.slice(0, 3).join(' ')}' exited with code ${code}`));
      }
    });
  });
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface BuildResult {
  success: boolean;
  imageTag: string;
  buildDir: string;
  gitSha?: string;
  durationMs: number;
  error?: string;
}

export interface CloneResult {
  success: boolean;
  buildDir: string;
  gitSha?: string;
  error?: string;
}

// ── Git operations ──────────────────────────────────────────────────────────

/**
 * Clone or pull a git repo for an app.
 * If the repo is already cloned, fetch + checkout the correct ref.
 * If not, clone fresh.
 * When logPath is provided, stdout/stderr are streamed to that file.
 */
export async function cloneOrPull(
  appName: string,
  repoUrl: string,
  ref: string,
  logPath?: string,
): Promise<CloneResult> {
  const buildDir = path.join(BUILDS_BASE, appName);

  // Helper: run with log if logPath provided, otherwise use buffered exec
  const run = async (cmd: string, args: string[], opts: { cwd?: string; timeout?: number }) => {
    if (logPath) {
      return runCommandWithLog(cmd, args, opts, logPath);
    }
    await exec(cmd, args, opts);
  };

  try {
    // Ensure builds base directory exists
    fs.mkdirSync(BUILDS_BASE, { recursive: true });

    const gitDir = path.join(buildDir, '.git');

    if (fs.existsSync(gitDir)) {
      // Repo already cloned — fetch and checkout
      await run('git', ['fetch', '--all', '--prune'], { cwd: buildDir, timeout: 120_000 });
      await run('git', ['checkout', ref], { cwd: buildDir, timeout: 30_000 });
      await run('git', ['pull', '--ff-only'], { cwd: buildDir, timeout: 120_000 }).catch(() => {
        // pull may fail if ref is a tag or detached HEAD — that's OK
      });
    } else {
      // Fresh clone
      if (fs.existsSync(buildDir)) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
      await run('git', ['clone', '--branch', ref, '--single-branch', repoUrl, buildDir], {
        timeout: 300_000, // 5 min max for large repos
      });
    }

    // Get current commit SHA (short exec — no need to stream)
    const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: buildDir });

    return {
      success: true,
      buildDir,
      gitSha: sha.trim(),
    };
  } catch (err) {
    return {
      success: false,
      buildDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Docker build ────────────────────────────────────────────────────────────

/**
 * Build a Docker image from a Dockerfile in the build directory.
 * Tags the image as app-<appName>:<version>.
 * When logPath is provided, stdout/stderr are streamed to that file.
 */
export async function buildImage(
  appName: string,
  buildDir: string,
  version: number,
  logPath?: string,
): Promise<BuildResult> {
  const imageTag = `app-${appName}:v${version}`;
  const latestTag = `app-${appName}:latest`;
  const start = Date.now();

  try {
    // Verify Dockerfile exists
    const dockerfilePath = path.join(buildDir, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      return {
        success: false,
        imageTag,
        buildDir,
        durationMs: Date.now() - start,
        error: `Dockerfile not found in ${buildDir}`,
      };
    }

    const dockerArgs = ['build', '-t', imageTag, '-t', latestTag, '--no-cache', '.'];

    if (logPath) {
      await runCommandWithLog('docker', dockerArgs, { cwd: buildDir, timeout: 600_000 }, logPath);
    } else {
      await exec('docker', dockerArgs, {
        cwd: buildDir,
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    // Get git SHA if available
    let gitSha: string | undefined;
    try {
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: buildDir });
      gitSha = stdout.trim();
    } catch {
      // Not a git repo or git not available — skip
    }

    return {
      success: true,
      imageTag,
      buildDir,
      gitSha,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      imageTag,
      buildDir,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Full build pipeline: clone/pull + docker build.
 * Always writes live output to BUILDS_BASE/<appName>/build.log.
 * Returns the image tag to use for container creation.
 */
export async function buildFromRepo(
  appName: string,
  repoUrl: string,
  ref: string,
  version: number,
): Promise<BuildResult> {
  const start = Date.now();
  const logPath = getBuildLogPath(appName);

  // Clear log at build start so the frontend always sees fresh output
  clearBuildLog(appName);

  // Stamp the log with build metadata
  const header = `Build started at ${new Date().toISOString()}\nApp: ${appName}  Repo: ${repoUrl}  Ref: ${ref}  Version: v${version}\n${'─'.repeat(60)}\n`;
  fs.appendFileSync(logPath, header);

  // Step 1: Clone or pull
  const cloneResult = await cloneOrPull(appName, repoUrl, ref, logPath);
  if (!cloneResult.success) {
    fs.appendFileSync(logPath, `\n[FAILED] Git clone/pull failed: ${cloneResult.error}\n`);
    return {
      success: false,
      imageTag: `app-${appName}:v${version}`,
      buildDir: cloneResult.buildDir,
      durationMs: Date.now() - start,
      error: `Git clone/pull failed: ${cloneResult.error}`,
    };
  }

  // Step 2: Docker build
  const buildResult = await buildImage(appName, cloneResult.buildDir, version, logPath);
  buildResult.gitSha = buildResult.gitSha ?? cloneResult.gitSha;

  const footer = `\n${'─'.repeat(60)}\nBuild ${buildResult.success ? 'SUCCEEDED' : 'FAILED'} in ${buildResult.durationMs}ms\n`;
  fs.appendFileSync(logPath, footer);

  return buildResult;
}
