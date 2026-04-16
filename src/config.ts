// ── Agent Configuration ─────────────────────────────────────────────────────
//
// Reads config from /opt/platform/agent/config/agent.yaml (mounted as /config
// inside the Docker container). Falls back to env vars and sensible defaults.
//
// Config file is written by the bootstrap script on the VPS.

import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

// ── Types ──────────────────────────────────────────────────────────────────

export type ServerRole = 'full' | 'app' | 'database' | 'worker';

export interface PostgresConfig {
  /** Access mode: 'local' (docker exec) or 'remote' (TCP) */
  mode: 'local' | 'remote';
  /** PostgreSQL container hostname (default: platform-postgres on platform-net) */
  host: string;
  /** PostgreSQL port */
  port: number;
  /** PostgreSQL superuser */
  user: string;
  /** PostgreSQL superuser password */
  password: string;
}

export interface AgentConfig {
  /** HTTP port the agent listens on */
  port: number;
  /** Bind address (default: 0.0.0.0 inside container, 127.0.0.1 for host) */
  host: string;
  /** Bearer token for API auth — generated at bootstrap */
  authToken: string;
  /** Agent version (from package.json) */
  version: string;
  /** Base path for platform state files */
  statePath: string;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rate limit: max requests per minute per IP */
  rateLimitMax: number;
  /** Server role — determines which modules to load */
  role: ServerRole;
  /** PostgreSQL connection config */
  postgres: PostgresConfig;
}

// ── YAML config file shape (matches bootstrap-scripts.ts output) ───────────

interface YamlConfig {
  server?: { port?: number; host?: string };
  auth?: { token?: string };
  logging?: { level?: string };
  state?: { path?: string };
  rateLimit?: { maxPerMinute?: number };
  role?: string;
  postgres?: {
    mode?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
  };
}

// ── Config paths ───────────────────────────────────────────────────────────

const CONFIG_PATHS = [
  '/config/agent.yaml', // Docker mount (primary)
  '/opt/platform/agent/config/agent.yaml', // Host fallback
];

// ── Loader ─────────────────────────────────────────────────────────────────

function loadYamlConfig(): YamlConfig {
  for (const configPath of CONFIG_PATHS) {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as YamlConfig;
      }
    }
  }
  return {};
}

function readVersion(): string {
  try {
    // In production (dist/), package.json is one level up
    const paths = ['../package.json', '../../package.json'];
    for (const p of paths) {
      const resolved = new URL(p, import.meta.url);
      if (existsSync(resolved)) {
        const pkg = JSON.parse(readFileSync(resolved, 'utf-8'));
        return pkg.version ?? '0.0.0';
      }
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

function isLogLevel(val: unknown): val is LogLevel {
  return typeof val === 'string' && VALID_LOG_LEVELS.includes(val as LogLevel);
}

export function loadConfig(): AgentConfig {
  const yamlCfg = loadYamlConfig();
  const env = process.env;

  const logLevel = env.LOG_LEVEL ?? yamlCfg.logging?.level ?? 'info';

  const role = (env.AGENT_ROLE ?? yamlCfg.role ?? 'full') as ServerRole;
  const validRoles: ServerRole[] = ['full', 'app', 'database', 'worker'];
  const resolvedRole = validRoles.includes(role) ? role : 'full';

  const pgMode = (env.PG_MODE ?? yamlCfg.postgres?.mode ?? 'local') as
    | 'local'
    | 'remote';
  const resolvedPgMode = pgMode === 'remote' ? 'remote' : 'local';

  return {
    port: toInt(env.AGENT_PORT) ?? yamlCfg.server?.port ?? 3100,
    host: env.AGENT_HOST ?? yamlCfg.server?.host ?? '0.0.0.0',
    authToken: env.AGENT_TOKEN ?? yamlCfg.auth?.token ?? '',
    version: readVersion(),
    statePath: env.STATE_PATH ?? yamlCfg.state?.path ?? '/var/lib/platform',
    logLevel: isLogLevel(logLevel) ? logLevel : 'info',
    rateLimitMax:
      toInt(env.RATE_LIMIT_MAX) ?? yamlCfg.rateLimit?.maxPerMinute ?? 100,
    role: resolvedRole,
    postgres: {
      mode: resolvedPgMode,
      host: env.PG_HOST ?? yamlCfg.postgres?.host ?? 'platform-postgres',
      port: toInt(env.PG_PORT) ?? yamlCfg.postgres?.port ?? 5432,
      user: env.PG_USER ?? yamlCfg.postgres?.user ?? 'platform',
      password: env.PG_PASSWORD ?? yamlCfg.postgres?.password ?? '',
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toInt(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}
