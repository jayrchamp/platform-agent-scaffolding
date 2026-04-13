// ── PostgreSQL Service ───────────────────────────────────────────────────────
//
// All PostgreSQL operations for the platform agent.
// Wraps pg.Pool — connects to the PostgreSQL container on platform-net.
//
// Connection: platform-postgres:5432 (superuser "platform")
// Admin operations connect to the "postgres" system database.
// Per-database queries (table stats, slow queries) open a temporary connection.
//
// Pattern identical to docker.ts: injectable pool for tests.

import { Pool, type PoolConfig } from 'pg';
import type { PostgresConfig } from '../config.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DatabaseInfo {
  name: string;
  owner: string;
  sizeMb: number;
  /** -1 = unlimited */
  connectionLimit: number;
}

export interface UserInfo {
  username: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canLogin: boolean;
  connectionLimit: number;
  validUntil: string | null;
}

export interface DryRunStep {
  label: string;
  status: 'ok' | 'warning' | 'error';
}

export interface DryRunResult {
  valid: boolean;
  /** SQL that would be executed */
  sql: string;
  steps: DryRunStep[];
  warnings: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  sizeMb: number;
  rowCount: number;
  lastVacuum: string | null;
  lastAnalyze: string | null;
}

export interface SlowQuery {
  query: string;
  avgMs: number;
  calls: number;
  totalMs: number;
}

export interface DatabaseDetail extends DatabaseInfo {
  activeConnections: number;
  tables: TableInfo[];
  slowQueries: SlowQuery[];
  hasStatStatements: boolean;
}

export interface ConnectionStats {
  active: number;
  idle: number;
  idleInTransaction: number;
  waiting: number;
  total: number;
  max: number;
  usagePercent: number;
}

export interface InstanceHealth {
  isRunning: boolean;
  version: string;
  uptime: string;
  connections: ConnectionStats;
  cacheHitRatio: number;
  transactions: {
    commits: number;
    rollbacks: number;
  };
  databases: number;
  postgresContainerName: string;
}

export interface ConnectionSample {
  timestamp: string;
  active: number;
  total: number;
  max: number;
}

export interface PgSetting {
  name: string;
  setting: string;
  unit: string;
  category: string;
  description: string;
  minVal: string;
  maxVal: string;
  resetVal: string;
  source: string;
  pendingRestart: boolean;
  requiresRestart: boolean;
}

export interface ConfigSuggestion {
  name: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
}

export type UserPrivilege = 'readonly' | 'readwrite' | 'admin';

// ── Pool management ────────────────────────────────────────────────────────

let adminPool: Pool | null = null;
let testPool: Pool | null = null;

/** Initialize the admin pool (called from buildApp). */
export function initPostgresPool(config: PostgresConfig): void {
  adminPool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: 'postgres',   // system DB for admin operations
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Override pool for tests */
export function setPgPool(pool: Pool): void {
  testPool = pool;
}

/** Reset to default pool (tests cleanup) */
export function resetPgPool(): void {
  testPool = null;
}

function getPool(): Pool {
  const p = testPool ?? adminPool;
  if (!p) throw new Error('PostgreSQL pool not initialized. Call initPostgresPool() first.');
  return p;
}

/** Temporary pool for a specific database (table stats, slow queries). */
function createDbPool(config: PostgresConfig, database: string): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Stored pg config (for per-DB connections). Set at initPostgresPool. */
let pgConfig: PostgresConfig | null = null;

export function initPostgres(config: PostgresConfig): void {
  pgConfig = config;
  initPostgresPool(config);
}

/** Close the admin pool gracefully. */
export async function closePostgresPool(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
}

// ── Validation helpers ─────────────────────────────────────────────────────

/** Valid PostgreSQL identifier: letters, digits, underscores. Max 63 chars. */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** System databases that must not be touched. */
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

/** System users (superusers) to protect from accidental deletion. */
const SYSTEM_USERS = new Set(['platform', 'postgres']);

function validateIdentifier(name: string, type: 'database' | 'user'): string | null {
  if (!name || name.trim() === '') return `${type} name is required`;
  if (!IDENTIFIER_RE.test(name)) {
    return `${type} name must start with a letter or underscore and contain only letters, numbers, or underscores (max 63 chars)`;
  }
  if (type === 'database' && SYSTEM_DATABASES.has(name)) {
    return `"${name}" is a system database and cannot be managed`;
  }
  if (type === 'user' && SYSTEM_USERS.has(name)) {
    return `"${name}" is a system user and cannot be managed`;
  }
  return null;
}

// ── Story 6.1 — Database CRUD ──────────────────────────────────────────────

export async function listDatabases(): Promise<DatabaseInfo[]> {
  const pool = getPool();
  const res = await pool.query<{
    datname: string;
    owner: string;
    size_bytes: string;
    datconnlimit: number;
  }>(`
    SELECT
      d.datname,
      pg_get_userbyid(d.datdba)                   AS owner,
      pg_database_size(d.datname)::text            AS size_bytes,
      d.datconnlimit
    FROM pg_database d
    WHERE NOT d.datistemplate
      AND d.datname NOT IN ('postgres', 'template0', 'template1')
    ORDER BY d.datname
  `);

  return res.rows.map((r) => ({
    name: r.datname,
    owner: r.owner,
    sizeMb: Math.round(Number(r.size_bytes) / 1024 / 1024 * 100) / 100,
    connectionLimit: r.datconnlimit,
  }));
}

export async function dryRunCreateDatabase(
  name: string,
  owner?: string,
): Promise<DryRunResult> {
  const steps: DryRunStep[] = [];
  const warnings: string[] = [];

  // Step 1 — Validate name
  const nameErr = validateIdentifier(name, 'database');
  if (nameErr) {
    steps.push({ label: 'Validate database name', status: 'error' });
    return { valid: false, sql: '', steps, warnings: [nameErr] };
  }
  steps.push({ label: `Validate database name "${name}"`, status: 'ok' });

  // Step 2 — Check database doesn't already exist
  const pool = getPool();
  const existsRes = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [name],
  );
  const alreadyExists = existsRes.rows[0]?.exists ?? false;
  if (alreadyExists) {
    steps.push({ label: `Check database "${name}" doesn't exist`, status: 'error' });
    return { valid: false, sql: '', steps, warnings: [`Database "${name}" already exists`] };
  }
  steps.push({ label: `Check database "${name}" doesn't exist`, status: 'ok' });

  // Step 3 — Validate owner (if provided)
  if (owner) {
    const ownerErr = validateIdentifier(owner, 'user');
    if (ownerErr) {
      steps.push({ label: `Validate owner "${owner}"`, status: 'error' });
      return { valid: false, sql: '', steps, warnings: [ownerErr] };
    }
    const ownerRes = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolcanlogin) AS exists',
      [owner],
    );
    const ownerExists = ownerRes.rows[0]?.exists ?? false;
    if (!ownerExists) {
      steps.push({ label: `Validate owner "${owner}"`, status: 'warning' });
      warnings.push(`User "${owner}" does not exist — database will be owned by the current user`);
    } else {
      steps.push({ label: `Validate owner "${owner}"`, status: 'ok' });
    }
  }

  // Build SQL
  const ownerClause = owner ? ` OWNER "${owner}"` : '';
  const sql = `CREATE DATABASE "${name}"${ownerClause};`;
  steps.push({ label: `Execute: ${sql}`, status: 'ok' });

  return { valid: true, sql, steps, warnings };
}

export async function createDatabase(
  name: string,
  owner?: string,
): Promise<DatabaseInfo> {
  const pool = getPool();
  // Note: identifiers cannot be parameterized in SQL — they must be quoted.
  // Owner is validated before this call.
  const ownerClause = owner ? ` OWNER "${owner}"` : '';
  await pool.query(`CREATE DATABASE "${name}"${ownerClause}`);

  // Fetch the created database info
  const res = await pool.query<{
    datname: string;
    owner: string;
    size_bytes: string;
    datconnlimit: number;
  }>(
    `SELECT datname, pg_get_userbyid(datdba) AS owner,
            pg_database_size(datname)::text AS size_bytes,
            datconnlimit
     FROM pg_database WHERE datname = $1`,
    [name],
  );

  const r = res.rows[0];
  if (!r) throw new Error(`Database "${name}" was not found after creation`);

  return {
    name: r.datname,
    owner: r.owner,
    sizeMb: Math.round(Number(r.size_bytes) / 1024 / 1024 * 100) / 100,
    connectionLimit: r.datconnlimit,
  };
}

export async function dryRunDropDatabase(name: string): Promise<DryRunResult> {
  const steps: DryRunStep[] = [];
  const warnings: string[] = [];

  // Step 1 — Validate name
  const nameErr = validateIdentifier(name, 'database');
  if (nameErr) {
    steps.push({ label: 'Validate database name', status: 'error' });
    return { valid: false, sql: '', steps, warnings: [nameErr] };
  }
  steps.push({ label: `Validate database name "${name}"`, status: 'ok' });

  // Step 2 — Check database exists
  const pool = getPool();
  const existsRes = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [name],
  );
  const exists = existsRes.rows[0]?.exists ?? false;
  if (!exists) {
    steps.push({ label: `Check database "${name}" exists`, status: 'error' });
    return { valid: false, sql: '', steps, warnings: [`Database "${name}" does not exist`] };
  }
  steps.push({ label: `Check database "${name}" exists`, status: 'ok' });

  // Step 3 — Check active connections
  const connRes = await pool.query<{ count: string }>(
    'SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [name],
  );
  const activeConns = parseInt(connRes.rows[0]?.count ?? '0', 10);
  if (activeConns > 0) {
    steps.push({ label: `Check active connections (${activeConns} found)`, status: 'warning' });
    warnings.push(
      `${activeConns} active connection${activeConns > 1 ? 's' : ''} will be terminated. DROP DATABASE WITH (FORCE) will be used.`,
    );
  } else {
    steps.push({ label: 'Check active connections (none)', status: 'ok' });
  }

  const sql = `DROP DATABASE "${name}" WITH (FORCE);`;
  steps.push({ label: `Execute: ${sql}`, status: 'warning' });
  warnings.push('This action is irreversible. All data in this database will be permanently deleted.');

  return { valid: true, sql, steps, warnings };
}

export async function dropDatabase(name: string): Promise<void> {
  const pool = getPool();
  // WITH (FORCE) terminates active connections (PostgreSQL 13+)
  await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

// ── Story 6.2 — User Management ────────────────────────────────────────────

export async function listUsers(): Promise<UserInfo[]> {
  const pool = getPool();
  const res = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
    rolconnlimit: number;
    rolvaliduntil: string | null;
  }>(`
    SELECT
      rolname,
      rolsuper,
      rolcreatedb,
      rolcanlogin,
      rolconnlimit,
      rolvaliduntil::text
    FROM pg_roles
    WHERE rolcanlogin = true
      AND rolname NOT IN ('platform', 'postgres', 'pg_monitor', 'pg_read_all_settings',
                          'pg_read_all_stats', 'pg_stat_scan_tables', 'pg_read_server_files',
                          'pg_write_server_files', 'pg_execute_server_program', 'pg_signal_backend',
                          'pg_checkpoint', 'pg_use_reserved_connections')
    ORDER BY rolname
  `);

  return res.rows.map((r) => ({
    username: r.rolname,
    isSuperuser: r.rolsuper,
    canCreateDb: r.rolcreatedb,
    canLogin: r.rolcanlogin,
    connectionLimit: r.rolconnlimit,
    validUntil: r.rolvaliduntil,
  }));
}

export async function dryRunCreateUser(
  username: string,
  privilege: UserPrivilege,
  database?: string,
): Promise<DryRunResult> {
  const steps: DryRunStep[] = [];
  const warnings: string[] = [];

  // Step 1 — Validate username
  const usernameErr = validateIdentifier(username, 'user');
  if (usernameErr) {
    steps.push({ label: 'Validate username', status: 'error' });
    return { valid: false, sql: '', steps, warnings: [usernameErr] };
  }
  steps.push({ label: `Validate username "${username}"`, status: 'ok' });

  // Step 2 — Check user doesn't exist
  const pool = getPool();
  const existsRes = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [username],
  );
  const alreadyExists = existsRes.rows[0]?.exists ?? false;
  if (alreadyExists) {
    steps.push({ label: `Check user "${username}" doesn't exist`, status: 'error' });
    return { valid: false, sql: '', steps, warnings: [`User "${username}" already exists`] };
  }
  steps.push({ label: `Check user "${username}" doesn't exist`, status: 'ok' });

  // Step 3 — Validate database (if provided)
  if (database) {
    const dbRes = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [database],
    );
    const dbExists = dbRes.rows[0]?.exists ?? false;
    if (!dbExists) {
      steps.push({ label: `Check database "${database}" exists`, status: 'warning' });
      warnings.push(`Database "${database}" does not exist — privileges cannot be granted`);
    } else {
      steps.push({ label: `Check database "${database}" exists`, status: 'ok' });
    }
  }

  const sql = buildCreateUserSql(username, '<generated-password>', privilege, database);
  steps.push({ label: 'Generate strong password', status: 'ok' });
  steps.push({ label: `Grant ${privilege} privileges`, status: 'ok' });
  steps.push({ label: `Execute: CREATE ROLE "${username}" LOGIN ...`, status: 'ok' });

  return { valid: true, sql, steps, warnings };
}

function buildCreateUserSql(
  username: string,
  password: string,
  privilege: UserPrivilege,
  database?: string,
): string {
  const lines: string[] = [
    `CREATE ROLE "${username}" LOGIN PASSWORD '${password}';`,
  ];

  if (privilege === 'admin') {
    lines.push(`ALTER ROLE "${username}" CREATEDB;`);
  }

  if (database) {
    lines.push(`GRANT CONNECT ON DATABASE "${database}" TO "${username}";`);
    if (privilege === 'readonly') {
      lines.push(`GRANT USAGE ON SCHEMA public TO "${username}";`);
      lines.push(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${username}";`);
      lines.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${username}";`);
    } else if (privilege === 'readwrite') {
      lines.push(`GRANT USAGE ON SCHEMA public TO "${username}";`);
      lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${username}";`);
      lines.push(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${username}";`);
      lines.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${username}";`);
      lines.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, UPDATE ON SEQUENCES TO "${username}";`);
    }
  }

  return lines.join('\n');
}

export async function createUser(
  username: string,
  password: string,
  privilege: UserPrivilege,
  database?: string,
): Promise<UserInfo> {
  const pool = getPool();

  // Create the role
  await pool.query(`CREATE ROLE "${username}" LOGIN PASSWORD $1`, [password]);

  if (privilege === 'admin') {
    await pool.query(`ALTER ROLE "${username}" CREATEDB`);
  }

  // Grant privileges on database (if provided)
  if (database) {
    await pool.query(`GRANT CONNECT ON DATABASE "${database}" TO "${username}"`);

    if (privilege === 'readonly') {
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${username}"`);
      await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${username}"`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${username}"`);
    } else if (privilege === 'readwrite') {
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${username}"`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${username}"`);
      await pool.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${username}"`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${username}"`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, UPDATE ON SEQUENCES TO "${username}"`);
    }
  }

  // Fetch the created user
  const res = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
    rolconnlimit: number;
    rolvaliduntil: string | null;
  }>(
    'SELECT rolname, rolsuper, rolcreatedb, rolcanlogin, rolconnlimit, rolvaliduntil::text FROM pg_roles WHERE rolname = $1',
    [username],
  );

  const r = res.rows[0];
  if (!r) throw new Error(`User "${username}" was not found after creation`);

  return {
    username: r.rolname,
    isSuperuser: r.rolsuper,
    canCreateDb: r.rolcreatedb,
    canLogin: r.rolcanlogin,
    connectionLimit: r.rolconnlimit,
    validUntil: r.rolvaliduntil,
  };
}

export async function rotatePassword(username: string, newPassword: string): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER ROLE "${username}" PASSWORD $1`, [newPassword]);
}

export async function dryRunDropUser(username: string): Promise<DryRunResult> {
  const steps: DryRunStep[] = [];
  const warnings: string[] = [];

  // Step 1 — Validate username
  const usernameErr = validateIdentifier(username, 'user');
  if (usernameErr) {
    steps.push({ label: 'Validate username', status: 'error' });
    return { valid: false, sql: '', steps, warnings: [usernameErr] };
  }
  steps.push({ label: `Validate username "${username}"`, status: 'ok' });

  // Step 2 — Check user exists
  const pool = getPool();
  const existsRes = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolcanlogin) AS exists',
    [username],
  );
  const exists = existsRes.rows[0]?.exists ?? false;
  if (!exists) {
    steps.push({ label: `Check user "${username}" exists`, status: 'error' });
    return { valid: false, sql: '', steps, warnings: [`User "${username}" does not exist`] };
  }
  steps.push({ label: `Check user "${username}" exists`, status: 'ok' });

  // Step 3 — Check if user owns any databases
  const ownsRes = await pool.query<{ count: string }>(
    "SELECT count(*) FROM pg_database WHERE pg_get_userbyid(datdba) = $1",
    [username],
  );
  const ownedDbs = parseInt(ownsRes.rows[0]?.count ?? '0', 10);
  if (ownedDbs > 0) {
    steps.push({ label: `Check owned databases (owns ${ownedDbs})`, status: 'warning' });
    warnings.push(
      `User "${username}" owns ${ownedDbs} database${ownedDbs > 1 ? 's' : ''}. You must reassign ownership before deleting this user.`,
    );
    return { valid: false, sql: '', steps, warnings };
  }
  steps.push({ label: 'Check owned databases (none)', status: 'ok' });

  // Step 4 — Check active connections
  const connRes = await pool.query<{ count: string }>(
    'SELECT count(*) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
    [username],
  );
  const activeConns = parseInt(connRes.rows[0]?.count ?? '0', 10);
  if (activeConns > 0) {
    steps.push({ label: `Check active connections (${activeConns} found)`, status: 'warning' });
    warnings.push(`${activeConns} active connection${activeConns > 1 ? 's' : ''} will be terminated.`);
  } else {
    steps.push({ label: 'Check active connections (none)', status: 'ok' });
  }

  const sql = `DROP ROLE "${username}";`;
  steps.push({ label: `Execute: ${sql}`, status: 'ok' });
  warnings.push('This action is irreversible. All privileges granted to this user will be removed.');

  return { valid: true, sql, steps, warnings };
}

export async function dropUser(username: string): Promise<void> {
  const pool = getPool();
  // Terminate active connections first
  await pool.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
    [username],
  );
  await pool.query(`DROP ROLE IF EXISTS "${username}"`);
}

// ── Story 6.3 — Database Detail ────────────────────────────────────────────

export async function getDatabaseDetail(
  name: string,
): Promise<DatabaseDetail> {
  const adminPgPool = getPool();

  // Basic info + connections from admin pool
  const basicRes = await adminPgPool.query<{
    datname: string;
    owner: string;
    size_bytes: string;
    datconnlimit: number;
    active_connections: string;
  }>(
    `SELECT
       d.datname,
       pg_get_userbyid(d.datdba)                          AS owner,
       pg_database_size(d.datname)::text                   AS size_bytes,
       d.datconnlimit,
       (SELECT count(*) FROM pg_stat_activity WHERE datname = $1)::text AS active_connections
     FROM pg_database d WHERE d.datname = $1`,
    [name],
  );

  const basic = basicRes.rows[0];
  if (!basic) throw new Error(`Database "${name}" not found`);

  // Per-database queries (table stats, slow queries) — need a separate connection
  let tables: TableInfo[] = [];
  let slowQueries: SlowQuery[] = [];
  let hasStatStatements = false;

  // Use test pool for in-process queries (if injected), otherwise create a per-DB pool
  const dbPool = testPool ?? (pgConfig ? createDbPool(pgConfig, name) : null);
  const shouldClosePool = !testPool && dbPool !== null;

  if (dbPool) {
    try {
      // Table stats
      const tableRes = await dbPool.query<{
        schemaname: string;
        tablename: string;
        size_bytes: string;
        row_count: string;
        last_vacuum: string | null;
        last_analyze: string | null;
      }>(`
        SELECT
          schemaname,
          tablename,
          pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))::text AS size_bytes,
          n_live_tup::text AS row_count,
          last_vacuum::text,
          last_analyze::text
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) DESC
        LIMIT 50
      `);

      tables = tableRes.rows.map((r) => ({
        schema: r.schemaname,
        name: r.tablename,
        sizeMb: Math.round(Number(r.size_bytes) / 1024 / 1024 * 100) / 100,
        rowCount: parseInt(r.row_count, 10),
        lastVacuum: r.last_vacuum,
        lastAnalyze: r.last_analyze,
      }));

      // Check if pg_stat_statements is available
      const extRes = await dbPool.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS exists",
      );
      hasStatStatements = extRes.rows[0]?.exists ?? false;

      if (hasStatStatements) {
        const slowRes = await dbPool.query<{
          query: string;
          avg_ms: string;
          calls: string;
          total_ms: string;
        }>(`
          SELECT
            LEFT(query, 200) AS query,
            (total_exec_time / calls)::numeric(10,2)::text AS avg_ms,
            calls::text,
            total_exec_time::numeric(10,2)::text AS total_ms
          FROM pg_stat_statements
          WHERE calls > 5
          ORDER BY avg_ms DESC
          LIMIT 20
        `);

        slowQueries = slowRes.rows.map((r) => ({
          query: r.query,
          avgMs: parseFloat(r.avg_ms),
          calls: parseInt(r.calls, 10),
          totalMs: parseFloat(r.total_ms),
        }));
      }
    } finally {
      if (shouldClosePool) await dbPool.end();
    }
  }

  return {
    name: basic.datname,
    owner: basic.owner,
    sizeMb: Math.round(Number(basic.size_bytes) / 1024 / 1024 * 100) / 100,
    connectionLimit: basic.datconnlimit,
    activeConnections: parseInt(basic.active_connections, 10),
    tables,
    slowQueries,
    hasStatStatements,
  };
}

export async function triggerVacuum(
  database: string,
  schema: string,
  table: string,
  full = false,
): Promise<void> {
  const dbPool = testPool ?? (pgConfig ? createDbPool(pgConfig, database) : null);
  if (!dbPool) throw new Error('PostgreSQL not configured');
  const shouldClose = !testPool;

  try {
    const vacuumSql = full
      ? `VACUUM (FULL, ANALYZE) "${schema}"."${table}"`
      : `VACUUM ANALYZE "${schema}"."${table}"`;
    await dbPool.query(vacuumSql);
  } finally {
    if (shouldClose) await dbPool.end();
  }
}

// ── Story 6.4 — Instance Health ────────────────────────────────────────────

export async function getInstanceHealth(): Promise<InstanceHealth> {
  const pool = getPool();

  // Version + uptime
  const versionRes = await pool.query<{ version: string }>('SELECT version()');
  const version = versionRes.rows[0]?.version ?? '';

  const uptimeRes = await pool.query<{ uptime: string }>(
    "SELECT date_trunc('second', now() - pg_postmaster_start_time())::text AS uptime",
  );
  const uptime = uptimeRes.rows[0]?.uptime ?? '';

  // Connections
  const connRes = await pool.query<{
    active: string;
    idle: string;
    idle_tx: string;
    waiting: string;
    total: string;
    max_conn: string;
  }>(`
    SELECT
      count(*) FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::text      AS active,
      count(*) FILTER (WHERE state = 'idle')::text                                     AS idle,
      count(*) FILTER (WHERE state = 'idle in transaction')::text                      AS idle_tx,
      count(*) FILTER (WHERE wait_event_type = 'Lock')::text                           AS waiting,
      (count(*) - 1)::text                                                             AS total,
      current_setting('max_connections')                                               AS max_conn
    FROM pg_stat_activity
  `);

  const c = connRes.rows[0];
  const maxConn = parseInt(c?.max_conn ?? '100', 10);
  const totalConn = parseInt(c?.total ?? '0', 10);

  const connections: ConnectionStats = {
    active: parseInt(c?.active ?? '0', 10),
    idle: parseInt(c?.idle ?? '0', 10),
    idleInTransaction: parseInt(c?.idle_tx ?? '0', 10),
    waiting: parseInt(c?.waiting ?? '0', 10),
    total: totalConn,
    max: maxConn,
    usagePercent: maxConn > 0 ? Math.round((totalConn / maxConn) * 100) : 0,
  };

  // Cache hit ratio
  const cacheRes = await pool.query<{ ratio: string | null }>(`
    SELECT
      CASE WHEN sum(blks_hit) + sum(blks_read) > 0
        THEN (sum(blks_hit) * 100.0 / (sum(blks_hit) + sum(blks_read)))::numeric(5,2)::text
        ELSE NULL
      END AS ratio
    FROM pg_stat_database
  `);
  const cacheHitRatio = parseFloat(cacheRes.rows[0]?.ratio ?? '0') || 0;

  // Transactions
  const txRes = await pool.query<{ commits: string; rollbacks: string }>(`
    SELECT
      sum(xact_commit)::text AS commits,
      sum(xact_rollback)::text AS rollbacks
    FROM pg_stat_database
  `);
  const transactions = {
    commits: parseInt(txRes.rows[0]?.commits ?? '0', 10),
    rollbacks: parseInt(txRes.rows[0]?.rollbacks ?? '0', 10),
  };

  // Database count
  const dbCountRes = await pool.query<{ count: string }>(
    "SELECT count(*)::text FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', 'template0', 'template1')",
  );
  const databases = parseInt(dbCountRes.rows[0]?.count ?? '0', 10);

  // Parse version string: "PostgreSQL 16.2 on x86_64-pc-linux-musl, ..."
  const versionShort = version.match(/PostgreSQL [\d.]+/)?.[0] ?? version.slice(0, 20);

  return {
    isRunning: true,
    version: versionShort,
    uptime,
    connections,
    cacheHitRatio,
    transactions,
    databases,
    postgresContainerName: 'platform-postgres',
  };
}

// ── Story 6.5 — Connection History (in-memory ring buffer) ─────────────────

const CONNECTION_HISTORY_MAX = 288; // 288 × 5min = 24h
const connectionHistory: ConnectionSample[] = [];

export function recordConnectionSample(stats: ConnectionStats): void {
  connectionHistory.push({
    timestamp: new Date().toISOString(),
    active: stats.active,
    total: stats.total,
    max: stats.max,
  });
  if (connectionHistory.length > CONNECTION_HISTORY_MAX) {
    connectionHistory.shift();
  }
}

export function getConnectionHistory(): ConnectionSample[] {
  return [...connectionHistory];
}

export function clearConnectionHistory(): void {
  connectionHistory.length = 0;
}

/** Analyse connection patterns and return recommendations. */
export function getPoolingRecommendations(history: ConnectionSample[]): string[] {
  if (history.length === 0) return [];
  const recommendations: string[] = [];

  const maxUsage = Math.max(...history.map((s) => (s.total / s.max) * 100));
  const avgUsage = history.reduce((sum, s) => sum + (s.total / s.max) * 100, 0) / history.length;

  if (maxUsage > 90) {
    recommendations.push(
      `Peak connection usage reached ${maxUsage.toFixed(0)}% of max_connections. Consider upgrading to pgBouncer immediately.`,
    );
  } else if (maxUsage > 70) {
    recommendations.push(
      `Connection usage peaked at ${maxUsage.toFixed(0)}%. Plan pgBouncer deployment before reaching 80%.`,
    );
  }

  if (avgUsage > 50) {
    recommendations.push(
      `Average connection usage is ${avgUsage.toFixed(0)}%. pgBouncer would significantly reduce connection overhead.`,
    );
  }

  const peakHours = history
    .filter((s) => (s.total / s.max) > 0.7)
    .map((s) => new Date(s.timestamp).getUTCHours());
  if (peakHours.length > 0) {
    const uniqueHours = [...new Set(peakHours)].sort((a, b) => a - b);
    recommendations.push(`High-load periods observed at UTC hours: ${uniqueHours.join(', ')}.`);
  }

  return recommendations;
}

// ── Story 6.6 — Database Configuration ────────────────────────────────────

/** Parameters that require a PostgreSQL restart to take effect. */
const RESTART_REQUIRED_PARAMS = new Set([
  'max_connections',
  'shared_buffers',
  'wal_buffers',
  'max_wal_size',
  'min_wal_size',
  'huge_pages',
  'max_prepared_transactions',
  'max_locks_per_transaction',
]);

/** Configurable params exposed through the UI. */
export const MANAGED_PG_PARAMS = [
  'max_connections',
  'shared_buffers',
  'effective_cache_size',
  'work_mem',
  'maintenance_work_mem',
  'checkpoint_completion_target',
  'wal_buffers',
  'default_statistics_target',
  'random_page_cost',
  'effective_io_concurrency',
  'max_wal_size',
  'min_wal_size',
] as const;

export type ManagedPgParam = (typeof MANAGED_PG_PARAMS)[number];

export async function getPgSettings(
  params: readonly string[] = MANAGED_PG_PARAMS,
): Promise<PgSetting[]> {
  const pool = getPool();
  const res = await pool.query<{
    name: string;
    setting: string;
    unit: string;
    category: string;
    short_desc: string;
    min_val: string | null;
    max_val: string | null;
    reset_val: string;
    source: string;
    pending_restart: boolean;
  }>(
    `SELECT
       name, setting, unit, category, short_desc,
       min_val, max_val, reset_val, source, pending_restart
     FROM pg_settings
     WHERE name = ANY($1::text[])
     ORDER BY category, name`,
    [params as string[]],
  );

  return res.rows.map((r) => ({
    name: r.name,
    setting: r.setting,
    unit: r.unit ?? '',
    category: r.category,
    description: r.short_desc,
    minVal: r.min_val ?? '',
    maxVal: r.max_val ?? '',
    resetVal: r.reset_val,
    source: r.source,
    pendingRestart: r.pending_restart,
    requiresRestart: RESTART_REQUIRED_PARAMS.has(r.name),
  }));
}

export async function setPgSetting(
  name: string,
  value: string,
): Promise<{ requiresRestart: boolean; pendingRestart: boolean }> {
  if (!MANAGED_PG_PARAMS.includes(name as ManagedPgParam)) {
    throw new Error(`Parameter "${name}" is not in the managed params list`);
  }

  const pool = getPool();

  // ALTER SYSTEM writes to postgresql.auto.conf
  await pool.query(`ALTER SYSTEM SET "${name}" = $1`, [value]);

  // Reload config (takes effect for non-restart params)
  const requiresRestart = RESTART_REQUIRED_PARAMS.has(name);
  if (!requiresRestart) {
    await pool.query('SELECT pg_reload_conf()');
  }

  // Check pending_restart state
  const res = await pool.query<{ pending_restart: boolean }>(
    'SELECT pending_restart FROM pg_settings WHERE name = $1',
    [name],
  );

  return {
    requiresRestart,
    pendingRestart: res.rows[0]?.pending_restart ?? requiresRestart,
  };
}

/** Suggest optimal parameter values based on available RAM (MB) and vCPUs. */
export function suggestPgSettings(totalRamMb: number, vCpus: number): ConfigSuggestion[] {
  const suggestions: ConfigSuggestion[] = [];

  // shared_buffers: 25% of RAM (max 8GB)
  const sharedBuffersMb = Math.min(Math.floor(totalRamMb * 0.25), 8192);
  suggestions.push({
    name: 'shared_buffers',
    currentValue: '',
    suggestedValue: `${sharedBuffersMb}MB`,
    reason: `25% of total RAM (${totalRamMb}MB). Improves cache hit rate for frequently accessed data.`,
  });

  // effective_cache_size: 50-75% of RAM
  const effectiveCacheMb = Math.floor(totalRamMb * 0.6);
  suggestions.push({
    name: 'effective_cache_size',
    currentValue: '',
    suggestedValue: `${effectiveCacheMb}MB`,
    reason: `60% of total RAM. Helps the query planner estimate available OS cache.`,
  });

  // work_mem: RAM / (max_connections * active_factor)
  // Rough estimate: assume 100 connections, active factor 2
  const workMemMb = Math.max(4, Math.floor(totalRamMb / 200));
  suggestions.push({
    name: 'work_mem',
    currentValue: '',
    suggestedValue: `${workMemMb}MB`,
    reason: `Estimated per-sort/hash operation memory. Larger values speed up sorts and hash joins at the cost of RAM.`,
  });

  // maintenance_work_mem: 10% of RAM, max 2GB
  const maintenanceMb = Math.min(Math.floor(totalRamMb * 0.1), 2048);
  suggestions.push({
    name: 'maintenance_work_mem',
    currentValue: '',
    suggestedValue: `${maintenanceMb}MB`,
    reason: `10% of RAM (max 2GB). Used for VACUUM, CREATE INDEX, and ALTER TABLE operations.`,
  });

  // wal_buffers: 64MB (good default for most workloads)
  suggestions.push({
    name: 'wal_buffers',
    currentValue: '',
    suggestedValue: '64MB',
    reason: `64MB is the recommended default for most workloads. Requires PostgreSQL restart.`,
  });

  // effective_io_concurrency: 200 for SSD (assumes Droplet has SSD)
  suggestions.push({
    name: 'effective_io_concurrency',
    currentValue: '',
    suggestedValue: '200',
    reason: `Droplets use SSD storage. 200 is the recommended value for SSD-backed storage.`,
  });

  // random_page_cost: 1.1 for SSD
  suggestions.push({
    name: 'random_page_cost',
    currentValue: '',
    suggestedValue: '1.1',
    reason: `SSD storage has near-sequential random I/O. 1.1 encourages the planner to prefer index scans.`,
  });

  // max_connections: estimate based on vCPUs (PG16 recommendation: 4x vCPUs, min 100)
  const maxConns = Math.max(100, vCpus * 4);
  suggestions.push({
    name: 'max_connections',
    currentValue: '',
    suggestedValue: String(maxConns),
    reason: `~4× vCPUs (${vCpus}). Each connection consumes ~5–10MB RAM. Use pgBouncer for higher concurrency needs.`,
  });

  return suggestions;
}
