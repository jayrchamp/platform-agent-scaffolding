// ── Build Service ───────────────────────────────────────────────────────────
//
// Handles git clone/pull and Docker image builds from Dockerfile.
// Build artifacts are stored in /var/lib/platform/builds/<appName>/.
//
// Flow:
//   1. cloneOrPull() — ensure repo is cloned and at the right ref
//   2. buildImage() — docker build from the repo's Dockerfile
//   3. Returns the local image tag (e.g. app-myapp:v3)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const exec = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────────────

const BUILDS_BASE = '/var/lib/platform/builds';

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
 */
export async function cloneOrPull(
  appName: string,
  repoUrl: string,
  ref: string,
): Promise<CloneResult> {
  const buildDir = path.join(BUILDS_BASE, appName);

  try {
    // Ensure builds base directory exists
    fs.mkdirSync(BUILDS_BASE, { recursive: true });

    const gitDir = path.join(buildDir, '.git');

    if (fs.existsSync(gitDir)) {
      // Repo already cloned — fetch and checkout
      await exec('git', ['fetch', '--all', '--prune'], { cwd: buildDir, timeout: 120_000 });
      await exec('git', ['checkout', ref], { cwd: buildDir, timeout: 30_000 });
      await exec('git', ['pull', '--ff-only'], { cwd: buildDir, timeout: 120_000 }).catch(() => {
        // pull may fail if ref is a tag or detached HEAD — that's OK
      });
    } else {
      // Fresh clone
      if (fs.existsSync(buildDir)) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
      await exec('git', ['clone', '--branch', ref, '--single-branch', repoUrl, buildDir], {
        timeout: 300_000, // 5 min max for large repos
      });
    }

    // Get current commit SHA
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
 */
export async function buildImage(
  appName: string,
  buildDir: string,
  version: number,
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

    // Build with both version tag and latest tag
    await exec('docker', [
      'build',
      '-t', imageTag,
      '-t', latestTag,
      '--no-cache',
      '.',
    ], {
      cwd: buildDir,
      timeout: 600_000, // 10 min max for builds
      maxBuffer: 10 * 1024 * 1024, // 10 MB stdout buffer
    });

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
 * Returns the image tag to use for container creation.
 */
export async function buildFromRepo(
  appName: string,
  repoUrl: string,
  ref: string,
  version: number,
): Promise<BuildResult> {
  const start = Date.now();

  // Step 1: Clone or pull
  const cloneResult = await cloneOrPull(appName, repoUrl, ref);
  if (!cloneResult.success) {
    return {
      success: false,
      imageTag: `app-${appName}:v${version}`,
      buildDir: cloneResult.buildDir,
      durationMs: Date.now() - start,
      error: `Git clone/pull failed: ${cloneResult.error}`,
    };
  }

  // Step 2: Docker build
  const buildResult = await buildImage(appName, cloneResult.buildDir, version);
  buildResult.gitSha = buildResult.gitSha ?? cloneResult.gitSha;

  return buildResult;
}
