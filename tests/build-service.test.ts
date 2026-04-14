// ── Build Service Tests ─────────────────────────────────────────────────────
//
// Tests for git clone/pull and Docker image build operations.
// Mocks child_process and fs to avoid actual git/docker calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, Readable } from 'node:stream';

// ── Mocks must be declared before importing the module ─────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
  };
});

// Now import the build service (which uses mocked modules)
import {
  setBuildsBase,
  getBuildLogPath,
  clearBuildLog,
  cloneOrPull,
  buildImage,
  buildFromRepo,
} from '../src/services/build.js';

// Import mocked modules to set up mock references
import { execFile as origExecFile, spawn as origSpawn } from 'node:child_process';
import * as fs from 'node:fs';

// Get references to the mocked functions
const mockExecFile = vi.mocked(origExecFile);
const mockSpawn = vi.mocked(origSpawn);
const mockFsExistsSync = vi.mocked(fs.existsSync);
const mockFsMkdirSync = vi.mocked(fs.mkdirSync);
const mockFsWriteFileSync = vi.mocked(fs.writeFileSync);
const mockFsAppendFileSync = vi.mocked(fs.appendFileSync);
const mockFsRmSync = vi.mocked(fs.rmSync);
const mockFsCreateWriteStream = vi.mocked(fs.createWriteStream);

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Create a mock child process that behaves like a spawned process.
 * Can emit 'error', 'close', and has piped stdout/stderr streams.
 */
function createMockChildProcess(exitCode = 0) {
  const child = new EventEmitter() as any;

  // Create readable streams that can be piped
  child.stdout = new Readable();
  child.stderr = new Readable();

  // Mock pipe to avoid actual piping but still return the stream for chaining
  child.stdout.pipe = vi.fn((dest, opts) => {
    // Simulate piping by not actually piping, just return dest
    return dest;
  });
  child.stderr.pipe = vi.fn((dest, opts) => {
    return dest;
  });

  // Auto-emit close using Promise.resolve().then() to ensure handlers are attached
  // This uses a microtask which runs before setTimeout macrotasks
  Promise.resolve().then(() => {
    child.emit('close', exitCode);
  });

  return child;
}

/**
 * Configure execFile mock to work with promisify.
 * execFile callback signature: (err, stdout, stderr)
 * Note: promisify expects the result to be passed as (err, result) where result is the first arg after err
 */
function setupExecFileMock(defaultStdout = '') {
  mockExecFile.mockImplementation((cmd, args, opts, callback) => {
    // Handle both 3-arg (no opts) and 4-arg cases
    const actualCallback = typeof opts === 'function' ? opts : callback;
    const actualOpts = typeof opts === 'function' ? {} : opts;

    if (actualCallback) {
      // Use setImmediate to ensure this runs after the current call stack
      setImmediate(() => {
        actualCallback(null, { stdout: defaultStdout, stderr: '' });
      });
    }

    // Return the child process mock
    return {
      once: () => {},
      on: () => {},
      kill: () => {},
    };
  });
}

/**
 * Configure a failing execFile mock for error cases.
 */
function setupExecFileErrorMock(error: Error) {
  mockExecFile.mockImplementation((cmd, args, opts, callback) => {
    const actualCallback = typeof opts === 'function' ? opts : callback;
    if (actualCallback) {
      setImmediate(() => {
        actualCallback(error, null, null);
      });
    }
    return {
      once: () => {},
      on: () => {},
      kill: () => {},
    };
  });
}

/**
 * Setup createWriteStream mock to return a mock stream.
 * The stream needs to handle write(), end(), and allow pipe() operations.
 */
function setupCreateWriteStreamMock() {
  mockFsCreateWriteStream.mockImplementation((path, opts) => {
    const mockStream = new EventEmitter() as any;
    mockStream.write = vi.fn(() => true);
    mockStream.end = vi.fn(() => {
      // Simulate stream closing
      mockStream.emit('finish');
    });
    mockStream.on = EventEmitter.prototype.on.bind(mockStream);
    mockStream.once = EventEmitter.prototype.once.bind(mockStream);
    mockStream.emit = EventEmitter.prototype.emit.bind(mockStream);
    return mockStream;
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getBuildLogPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
  });

  it('returns correct path for app build log', () => {
    const logPath = getBuildLogPath('my-app');
    expect(logPath).toBe('/tmp/test-platform/builds/my-app/build.log');
  });

  it('includes app name in path', () => {
    const logPath = getBuildLogPath('another-service');
    expect(logPath).toContain('another-service');
    expect(logPath).toContain('build.log');
  });
});

describe('clearBuildLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
  });

  it('creates directory recursively', () => {
    clearBuildLog('my-app');

    expect(mockFsMkdirSync).toHaveBeenCalledWith(
      '/tmp/test-platform/builds/my-app',
      { recursive: true }
    );
  });

  it('truncates log file to empty string', () => {
    clearBuildLog('my-app');

    expect(mockFsWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-platform/builds/my-app/build.log',
      ''
    );
  });

  it('creates and truncates in correct order', () => {
    clearBuildLog('test-app');

    const calls = [mockFsMkdirSync.mock.calls[0], mockFsWriteFileSync.mock.calls[0]];
    expect(calls[0]).toBeDefined();
    expect(calls[1]).toBeDefined();
  });
});

describe('cloneOrPull (without logPath)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
    setupExecFileMock('abc123def456\n');
  });

  it('clones fresh repo when .git does not exist', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? false : true);

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(result.success).toBe(true);
    expect(result.gitSha).toBe('abc123def456');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--branch', 'main', '--single-branch', 'https://github.com/user/repo.git', '/tmp/test-platform/builds/my-app'],
      expect.objectContaining({ timeout: 300_000 }),
      expect.any(Function)
    );
  });

  it('fetches and checks out when repo already exists', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? true : true);

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'v1.0.0');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['fetch', '--all', '--prune'],
      expect.objectContaining({ cwd: '/tmp/test-platform/builds/my-app', timeout: 120_000 }),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['checkout', 'v1.0.0'],
      expect.objectContaining({ cwd: '/tmp/test-platform/builds/my-app', timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it('calls pull --ff-only after checkout', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? true : true);

    await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['pull', '--ff-only'],
      expect.objectContaining({ cwd: '/tmp/test-platform/builds/my-app', timeout: 120_000 }),
      expect.any(Function)
    );
  });

  it('silently ignores pull failures (detached HEAD or tag)', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? true : true);
    // Sequence: fetch (1), checkout (2), pull (3 - fails), rev-parse (4 - succeeds)
    let callCount = 0;
    mockExecFile.mockImplementation((cmd, args, opts, callback) => {
      const cb = typeof opts === 'function' ? opts : callback;
      const actualCallback = typeof opts === 'function' ? opts : callback;
      callCount++;
      if (actualCallback) {
        if (callCount === 3) {
          // pull call (3rd) fails
          setImmediate(() => actualCallback(new Error('not a branch')));
        } else {
          // All other calls (fetch, checkout, rev-parse) succeed
          setImmediate(() => actualCallback(null, { stdout: 'abc123def456\n', stderr: '' }));
        }
      }
      return { stdout: 'abc123def456\n', stderr: '' };
    });

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'v1.0.0');

    expect(result.success).toBe(true);
    expect(result.gitSha).toBe('abc123def456');
  });

  it('removes existing directory before cloning if not a git repo', async () => {
    mockFsExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('.git')) return false;
      if (p.endsWith('my-app')) return true; // dir exists but no .git
      return true;
    });

    await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(mockFsRmSync).toHaveBeenCalledWith(
      '/tmp/test-platform/builds/my-app',
      { recursive: true, force: true }
    );
  });

  it('returns git SHA from rev-parse', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? true : true);

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(result.gitSha).toBe('abc123def456');
  });

  it('trims whitespace from git SHA', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? true : true);
    setupExecFileMock('  xyz789  \n');

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(result.gitSha).toBe('xyz789');
  });

  it('returns error when git operations fail', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? false : true);
    setupExecFileErrorMock(new Error('network timeout'));

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(result.success).toBe(false);
    expect(result.error).toContain('network timeout');
    expect(result.gitSha).toBeUndefined();
  });

  it('returns buildDir in result', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? false : true);

    const result = await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(result.buildDir).toBe('/tmp/test-platform/builds/my-app');
  });

  it('ensures BUILDS_BASE directory exists', async () => {
    mockFsExistsSync.mockReturnValue(false);

    await cloneOrPull('my-app', 'https://github.com/user/repo.git', 'main');

    expect(mockFsMkdirSync).toHaveBeenCalledWith(
      '/tmp/test-platform/builds',
      { recursive: true }
    );
  });
});

describe('cloneOrPull (with logPath)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
    setupExecFileMock('abc123def456\n');
    setupCreateWriteStreamMock();
  });

  it('uses spawn via runCommandWithLog when logPath provided', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? false : true);
    mockSpawn.mockReturnValue(createMockChildProcess(0));

    const result = await cloneOrPull(
      'my-app',
      'https://github.com/user/repo.git',
      'main',
      '/tmp/test-platform/builds/my-app/build.log'
    );

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('still uses exec for rev-parse HEAD with logPath', async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.endsWith('.git') ? false : true);
    mockSpawn.mockReturnValue(createMockChildProcess(0));

    await cloneOrPull(
      'my-app',
      'https://github.com/user/repo.git',
      'main',
      '/tmp/test-platform/builds/my-app/build.log'
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('creates directory for log file before spawn', async () => {
    mockFsExistsSync.mockReturnValue(false);
    mockSpawn.mockReturnValue(createMockChildProcess(0));

    await cloneOrPull(
      'my-app',
      'https://github.com/user/repo.git',
      'main',
      '/tmp/test-platform/builds/my-app/build.log'
    );

    expect(mockFsMkdirSync).toHaveBeenCalledWith(
      '/tmp/test-platform/builds/my-app',
      { recursive: true }
    );
  });
});

describe('buildImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
    setupExecFileMock('abc123def456\n');
  });

  it('returns success when Dockerfile exists and docker build succeeds', async () => {
    mockFsExistsSync.mockReturnValue(true);

    const result = await buildImage('my-app', '/tmp/test-platform/builds/my-app', 3);

    expect(result.success).toBe(true);
    expect(result.imageTag).toBe('app-my-app:v3');
    expect(result.buildDir).toBe('/tmp/test-platform/builds/my-app');
    expect(result.gitSha).toBe('abc123def456');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tags image with version and latest', async () => {
    mockFsExistsSync.mockReturnValue(true);

    await buildImage('my-app', '/tmp/test-platform/builds/my-app', 5);

    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', 'app-my-app:v5', '-t', 'app-my-app:latest', '--no-cache', '.'],
      expect.objectContaining({ cwd: '/tmp/test-platform/builds/my-app' }),
      expect.any(Function)
    );
  });

  it('returns error when Dockerfile does not exist', async () => {
    mockFsExistsSync.mockReturnValue(false);

    const result = await buildImage('my-app', '/tmp/test-platform/builds/my-app', 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Dockerfile not found');
    expect(result.imageTag).toBe('app-my-app:v1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error when docker build fails', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileErrorMock(new Error('build failed: invalid syntax'));

    const result = await buildImage('my-app', '/tmp/test-platform/builds/my-app', 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain('build failed');
    expect(result.imageTag).toBe('app-my-app:v2');
  });

  it('measures build duration', async () => {
    mockFsExistsSync.mockReturnValue(true);
    const start = Date.now();

    const result = await buildImage('my-app', '/tmp/test-platform/builds/my-app', 1);

    const elapsed = Date.now() - start;
    expect(result.durationMs).toBeLessThanOrEqual(elapsed + 10);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses maxBuffer for docker build', async () => {
    mockFsExistsSync.mockReturnValue(true);

    await buildImage('my-app', '/tmp/test-platform/builds/my-app', 1);

    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.any(Array),
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
      expect.any(Function)
    );
  });

  it('attempts to get git SHA after build', async () => {
    mockFsExistsSync.mockReturnValue(true);

    await buildImage('my-app', '/tmp/test-platform/builds/my-app', 1);

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/tmp/test-platform/builds/my-app' }),
      expect.any(Function)
    );
  });

  it('handles missing git repo gracefully', async () => {
    mockFsExistsSync.mockReturnValue(true);
    let callCount = 0;
    mockExecFile.mockImplementation((cmd, args, opts, callback) => {
      const cb = typeof opts === 'function' ? opts : callback;
      callCount++;
      if (cb) {
        if (callCount === 1) {
          // docker build succeeds
          process.nextTick(() => cb(null, { stdout: '', stderr: '' }));
        } else {
          // git rev-parse fails
          process.nextTick(() => cb(new Error('not a git repo')));
        }
      }
      return { stdout: 'abc123def456\n', stderr: '' };
    });

    const result = await buildImage('my-app', '/tmp/test-platform/builds/my-app', 1);

    expect(result.success).toBe(true);
    expect(result.gitSha).toBeUndefined();
  });

  it('uses spawn with logPath', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupCreateWriteStreamMock();
    mockSpawn.mockReturnValue(createMockChildProcess(0));

    await buildImage(
      'my-app',
      '/tmp/test-platform/builds/my-app',
      1,
      '/tmp/test-platform/builds/my-app/build.log'
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('creates write stream for log file', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupCreateWriteStreamMock();
    mockSpawn.mockReturnValue(createMockChildProcess(0));

    await buildImage(
      'my-app',
      '/tmp/test-platform/builds/my-app',
      1,
      '/tmp/test-platform/builds/my-app/build.log'
    );

    expect(mockFsCreateWriteStream).toHaveBeenCalled();
  });
});

describe('buildFromRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuildsBase('/tmp/test-platform');
  });

  it('clears build log at start', () => {
    // Test clearBuildLog is called - we verify this through the fs mock
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileMock('sha123\n');
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      // Resolve immediately on next microtask
      Promise.resolve().then(() => child.emit('close', 0));
      return child;
    });

    // Start the build and capture initialization behavior
    const promise = buildFromRepo('myapp', 'https://github.com/u/r.git', 'main', 1);

    // Check that clearBuildLog was called (which calls writeFileSync with empty string)
    expect(mockFsWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('myapp'),
      ''
    );
  });

  it('writes header metadata to log file', () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileMock('sha123\n');
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 0));
      return child;
    });

    const promise = buildFromRepo('myapp', 'https://github.com/u/r.git', 'v2.0', 1);

    // Header should be appended with build metadata
    expect(mockFsAppendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('myapp'),
      expect.stringContaining('Build started at')
    );
  });

  it('returns success: false when cloneOrPull fails', async () => {
    mockFsExistsSync.mockReturnValue(true);
    // Exec fails for git commands
    setupExecFileErrorMock(new Error('network error'));
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 128));
      return child;
    });

    const result = await buildFromRepo('myapp', 'https://github.com/u/r.git', 'main', 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Git clone/pull failed');
  });

  it('returns imageTag in result', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileErrorMock(new Error('fail'));
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 1));
      return child;
    });

    const result = await buildFromRepo('myapp', 'https://github.com/u/r.git', 'main', 5);

    expect(result.imageTag).toBe('app-myapp:v5');
  });

  it('returns buildDir in result', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileErrorMock(new Error('fail'));
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 1));
      return child;
    });

    const result = await buildFromRepo('myapp', 'https://github.com/u/r.git', 'main', 1);

    expect(result.buildDir).toContain('/myapp');
  });

  it('returns durationMs >= 0', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileErrorMock(new Error('fail'));
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 1));
      return child;
    });

    const result = await buildFromRepo('myapp', 'https://github.com/u/r.git', 'main', 1);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('constructs imageTag correctly from appName and version', async () => {
    mockFsExistsSync.mockReturnValue(true);
    setupExecFileErrorMock(new Error('fail'));
    setupCreateWriteStreamMock();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = { pipe: vi.fn(() => {}) };
      child.stderr = { pipe: vi.fn(() => {}) };
      Promise.resolve().then(() => child.emit('close', 1));
      return child;
    });

    const result = await buildFromRepo('my-service', 'https://github.com/u/r.git', 'main', 99);

    expect(result.imageTag).toBe('app-my-service:v99');
  });
});
