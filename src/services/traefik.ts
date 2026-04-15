// ── Traefik Service ─────────────────────────────────────────────────────────
//
// Manages dynamic Traefik route configuration via YAML files in the
// /opt/platform/traefik/dynamic/ directory. Traefik watches this directory
// and applies changes in real-time (no restart needed).
//
// Also reads certificate information from the ACME storage file.

import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

// ── Constants ──────────────────────────────────────────────────────────────

const DYNAMIC_DIR = '/opt/platform/traefik/dynamic';
const ACME_FILE = '/opt/platform/traefik/certs/acme.json';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TraefikRouteInfo {
  appName: string;
  domain: string;
  containerName: string;
  port: number;
  configFile: string;
}

export interface CertificateInfo {
  domain: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;
  isExpiringSoon: boolean;
}

// ── Internal types for YAML structure ──────────────────────────────────────

interface TraefikDynamicConfig {
  http?: {
    routers?: Record<
      string,
      {
        rule?: string;
        service?: string;
        entryPoints?: string[];
        tls?: { certResolver?: string };
        middlewares?: string[];
      }
    >;
    services?: Record<
      string,
      { loadBalancer?: { servers?: Array<{ url?: string }> } }
    >;
    middlewares?: Record<string, unknown>;
  };
}

interface AcmeStorage {
  [resolverName: string]: {
    Account?: unknown;
    Certificates?: Array<{
      domain?: { main?: string; sans?: string[] };
      certificate?: string;
      key?: string;
    }>;
  };
}

// ── Override paths for testing ──────────────────────────────────────────────

let dynamicDir = DYNAMIC_DIR;
let acmeFile = ACME_FILE;

export function setTraefikPaths(paths: {
  dynamicDir?: string;
  acmeFile?: string;
}): void {
  if (paths.dynamicDir) dynamicDir = paths.dynamicDir;
  if (paths.acmeFile) acmeFile = paths.acmeFile;
}

export function resetTraefikPaths(): void {
  dynamicDir = DYNAMIC_DIR;
  acmeFile = ACME_FILE;
}

// ── Route management ───────────────────────────────────────────────────────

/**
 * Write a Traefik dynamic route config for an app.
 * Uses atomic write (temp file + rename) to prevent Traefik from reading a partial file.
 */
export async function writeRouteConfig(
  appName: string,
  domain: string,
  containerName: string,
  port: number
): Promise<void> {
  const config: TraefikDynamicConfig = {
    http: {
      routers: {
        [appName]: {
          rule: `Host(\`${domain}\`)`,
          service: appName,
          entryPoints: ['websecure'],
          tls: { certResolver: 'letsencrypt' },
        },
        [`${appName}-http`]: {
          rule: `Host(\`${domain}\`)`,
          service: appName,
          entryPoints: ['web'],
          middlewares: [`${appName}-redirect-https`],
        },
      },
      services: {
        [appName]: {
          loadBalancer: {
            servers: [{ url: `http://${containerName}:${port}` }],
          },
        },
      },
      middlewares: {
        [`${appName}-redirect-https`]: {
          redirectScheme: {
            scheme: 'https',
            permanent: true,
          },
        },
      },
    },
  };

  const yamlContent = yaml.dump(config, { lineWidth: -1, noRefs: true });
  const filePath = join(dynamicDir, `${appName}.yml`);
  const tmpPath = `${filePath}.tmp`;

  // Atomic write: write to temp file then rename
  await writeFile(tmpPath, yamlContent, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Remove a Traefik dynamic route config for an app.
 * No-op if the file doesn't exist.
 */
export async function removeRouteConfig(appName: string): Promise<void> {
  const filePath = join(dynamicDir, `${appName}.yml`);
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    // ENOENT is fine — file already gone
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw err;
  }
}

/**
 * List all active dynamic route configs by parsing .yml files in the dynamic directory.
 */
export async function listRouteConfigs(): Promise<TraefikRouteInfo[]> {
  let files: string[];
  try {
    files = await readdir(dynamicDir);
  } catch {
    return [];
  }

  const ymlFiles = files.filter(
    (f) => f.endsWith('.yml') && !f.endsWith('.tmp')
  );
  const routes: TraefikRouteInfo[] = [];

  for (const file of ymlFiles) {
    const filePath = join(dynamicDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = yaml.load(content) as TraefikDynamicConfig;
      const appName = file.replace(/\.yml$/, '');

      // Extract domain from the main router rule
      const mainRouter = parsed?.http?.routers?.[appName];
      const domainMatch = mainRouter?.rule?.match(/Host\(`([^`]+)`\)/);
      const domain = domainMatch?.[1] ?? '';

      // Extract container name and port from the service loadbalancer
      const service = parsed?.http?.services?.[appName];
      const serverUrl = service?.loadBalancer?.servers?.[0]?.url ?? '';
      const urlMatch = serverUrl.match(/^https?:\/\/([^:]+):(\d+)$/);
      const containerNameParsed = urlMatch?.[1] ?? '';
      const port = urlMatch ? parseInt(urlMatch[2], 10) : 0;

      routes.push({
        appName,
        domain,
        containerName: containerNameParsed,
        port,
        configFile: filePath,
      });
    } catch {
      // Skip malformed files
    }
  }

  return routes;
}

// ── Certificate monitoring ─────────────────────────────────────────────────

/**
 * Parse acme.json and return all certificates with domain, dates, and issuer info.
 */
export async function getCertificates(): Promise<CertificateInfo[]> {
  let content: string;
  try {
    content = await readFile(acmeFile, 'utf-8');
  } catch {
    return [];
  }

  const storage = JSON.parse(content) as AcmeStorage;
  const certs: CertificateInfo[] = [];

  // Iterate over all resolvers (we expect "letsencrypt")
  for (const resolver of Object.values(storage)) {
    if (!resolver.Certificates) continue;

    for (const cert of resolver.Certificates) {
      const domain = cert.domain?.main;
      if (!domain || !cert.certificate) continue;

      const certInfo = parseCertificate(cert.certificate);
      if (certInfo) {
        certs.push(certInfo);
      }
    }
  }

  return certs;
}

/**
 * Get certificate info for a specific domain, or null if not found.
 */
export async function getCertificateForDomain(
  domain: string
): Promise<CertificateInfo | null> {
  const all = await getCertificates();
  return all.find((c) => c.domain === domain) ?? null;
}

// ── Certificate parsing helpers ────────────────────────────────────────────

/**
 * Parse a base64-encoded PEM certificate to extract subject, issuer, and dates.
 * Uses a lightweight regex approach instead of a full ASN.1 parser.
 */
function parseCertificate(certBase64: string): CertificateInfo | null {
  try {
    const pem = Buffer.from(certBase64, 'base64').toString('utf-8');

    // Use Node.js crypto to parse X.509
    const { X509Certificate } = require('node:crypto');
    const x509 = new X509Certificate(pem);

    const domain = extractCN(x509.subject);
    const issuer = extractCN(x509.issuer);
    const notBefore = new Date(x509.validFrom).toISOString();
    const notAfter = new Date(x509.validTo).toISOString();
    const daysRemaining = Math.floor(
      (new Date(x509.validTo).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    return {
      domain,
      issuer,
      notBefore,
      notAfter,
      daysRemaining,
      isExpiringSoon: daysRemaining < 30,
    };
  } catch {
    return null;
  }
}

/** Extract Common Name from an X.509 subject/issuer string like "CN=example.com" */
function extractCN(str: string): string {
  const match = str.match(/CN=([^\n,]+)/);
  return match?.[1]?.trim() ?? '';
}
