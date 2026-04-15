// ── Traefik Service Tests ──────────────────────────────────────────────────────
//
// Tests for the Traefik dynamic route management service.
// Uses real filesystem (temp dir) for route config tests
// and mocked acme.json for certificate parsing tests.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

import {
  writeRouteConfig,
  removeRouteConfig,
  listRouteConfigs,
  getCertificates,
  getCertificateForDomain,
  setTraefikPaths,
  resetTraefikPaths,
} from '../src/services/traefik.js';

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let dynamicDir: string;
let acmeFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-traefik-'));
  dynamicDir = join(tmpDir, 'dynamic');
  acmeFile = join(tmpDir, 'acme.json');
  mkdirSync(dynamicDir, { recursive: true });
  setTraefikPaths({ dynamicDir, acmeFile });
});

afterAll(() => {
  resetTraefikPaths();
});

// ── writeRouteConfig ──────────────────────────────────────────────────────────

describe('writeRouteConfig', () => {
  it('creates a valid YAML file with correct structure', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'my-app-web-abc123', 3000);

    const filePath = join(dynamicDir, 'my-app.yml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;

    // Check routers
    const routers = (parsed as any).http.routers;
    expect(routers['my-app'].rule).toBe('Host(`app.example.com`)');
    expect(routers['my-app'].service).toBe('my-app');
    expect(routers['my-app'].entryPoints).toEqual(['websecure']);
    expect(routers['my-app'].tls.certResolver).toBe('letsencrypt');

    // Check HTTP router with redirect middleware
    expect(routers['my-app-http'].rule).toBe('Host(`app.example.com`)');
    expect(routers['my-app-http'].entryPoints).toEqual(['web']);
    expect(routers['my-app-http'].middlewares).toEqual(['my-app-redirect-https']);

    // Check services
    const services = (parsed as any).http.services;
    expect(services['my-app'].loadBalancer.servers).toEqual([
      { url: 'http://my-app-web-abc123:3000' },
    ]);

    // Check middlewares
    const middlewares = (parsed as any).http.middlewares;
    expect(middlewares['my-app-redirect-https'].redirectScheme).toEqual({
      scheme: 'https',
      permanent: true,
    });
  });

  it('overwrites existing config when called again', async () => {
    await writeRouteConfig('my-app', 'old.example.com', 'old-container', 3000);
    await writeRouteConfig('my-app', 'new.example.com', 'new-container', 8080);

    const content = readFileSync(join(dynamicDir, 'my-app.yml'), 'utf-8');
    const parsed = yaml.load(content) as any;

    expect(parsed.http.routers['my-app'].rule).toBe('Host(`new.example.com`)');
    expect(parsed.http.services['my-app'].loadBalancer.servers[0].url).toBe(
      'http://new-container:8080',
    );
  });

  it('does not leave temp files after write', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'container', 3000);

    const files = require('node:fs').readdirSync(dynamicDir);
    expect(files).toEqual(['my-app.yml']);
    expect(files.some((f: string) => f.endsWith('.tmp'))).toBe(false);
  });

  it('handles app names with hyphens and numbers', async () => {
    await writeRouteConfig('my-app-2', 'app2.example.com', 'my-app-2-web-def456', 4000);

    const filePath = join(dynamicDir, 'my-app-2.yml');
    expect(existsSync(filePath)).toBe(true);

    const parsed = yaml.load(readFileSync(filePath, 'utf-8')) as any;
    expect(parsed.http.routers['my-app-2'].rule).toBe('Host(`app2.example.com`)');
  });
});

// ── removeRouteConfig ─────────────────────────────────────────────────────────

describe('removeRouteConfig', () => {
  it('removes the config file', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'container', 3000);
    expect(existsSync(join(dynamicDir, 'my-app.yml'))).toBe(true);

    await removeRouteConfig('my-app');
    expect(existsSync(join(dynamicDir, 'my-app.yml'))).toBe(false);
  });

  it('does not throw when file does not exist', async () => {
    await expect(removeRouteConfig('nonexistent')).resolves.toBeUndefined();
  });
});

// ── listRouteConfigs ──────────────────────────────────────────────────────────

describe('listRouteConfigs', () => {
  it('returns empty array when directory is empty', async () => {
    const routes = await listRouteConfigs();
    expect(routes).toEqual([]);
  });

  it('lists all route configs correctly', async () => {
    await writeRouteConfig('app-one', 'one.example.com', 'app-one-web-aaa', 3000);
    await writeRouteConfig('app-two', 'two.example.com', 'app-two-web-bbb', 4000);

    const routes = await listRouteConfigs();
    expect(routes).toHaveLength(2);

    const routeOne = routes.find((r) => r.appName === 'app-one');
    expect(routeOne).toBeDefined();
    expect(routeOne!.domain).toBe('one.example.com');
    expect(routeOne!.containerName).toBe('app-one-web-aaa');
    expect(routeOne!.port).toBe(3000);

    const routeTwo = routes.find((r) => r.appName === 'app-two');
    expect(routeTwo).toBeDefined();
    expect(routeTwo!.domain).toBe('two.example.com');
    expect(routeTwo!.containerName).toBe('app-two-web-bbb');
    expect(routeTwo!.port).toBe(4000);
  });

  it('skips .tmp files', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'container', 3000);
    // Manually create a .tmp file
    writeFileSync(join(dynamicDir, 'my-app.yml.tmp'), 'partial content');

    const routes = await listRouteConfigs();
    expect(routes).toHaveLength(1);
    expect(routes[0].appName).toBe('my-app');
  });

  it('skips malformed YAML files', async () => {
    await writeRouteConfig('good-app', 'good.example.com', 'container', 3000);
    writeFileSync(join(dynamicDir, 'bad-app.yml'), '{{invalid yaml');

    const routes = await listRouteConfigs();
    expect(routes).toHaveLength(1);
    expect(routes[0].appName).toBe('good-app');
  });

  it('returns empty array when directory does not exist', async () => {
    setTraefikPaths({ dynamicDir: join(tmpDir, 'nonexistent') });

    const routes = await listRouteConfigs();
    expect(routes).toEqual([]);
  });
});

// ── getCertificates ───────────────────────────────────────────────────────────

describe('getCertificates', () => {
  it('returns empty array when acme.json does not exist', async () => {
    const certs = await getCertificates();
    expect(certs).toEqual([]);
  });

  it('returns empty array when acme.json has no certificates', async () => {
    writeFileSync(
      acmeFile,
      JSON.stringify({
        letsencrypt: { Account: {}, Certificates: [] },
      }),
    );

    const certs = await getCertificates();
    expect(certs).toEqual([]);
  });

  it('parses certificates from acme.json', async () => {
    // Create a self-signed cert for testing
    const { X509Certificate } = require('node:crypto');
    const { generateKeyPairSync, createSign } = require('node:crypto');

    // Generate a simple self-signed cert
    const certPem = generateSelfSignedCert('test.example.com');

    writeFileSync(
      acmeFile,
      JSON.stringify({
        letsencrypt: {
          Account: {},
          Certificates: [
            {
              domain: { main: 'test.example.com' },
              certificate: Buffer.from(certPem).toString('base64'),
              key: '',
            },
          ],
        },
      }),
    );

    const certs = await getCertificates();
    expect(certs).toHaveLength(1);
    expect(certs[0].domain).toBe('test.example.com');
    expect(certs[0].notBefore).toBeDefined();
    expect(certs[0].notAfter).toBeDefined();
    expect(typeof certs[0].daysRemaining).toBe('number');
    expect(typeof certs[0].isExpiringSoon).toBe('boolean');
  });
});

// ── getCertificateForDomain ───────────────────────────────────────────────────

describe('getCertificateForDomain', () => {
  it('returns null when no certificates exist', async () => {
    const cert = await getCertificateForDomain('example.com');
    expect(cert).toBeNull();
  });

  it('returns null when domain is not found', async () => {
    const certPem = generateSelfSignedCert('other.example.com');
    writeFileSync(
      acmeFile,
      JSON.stringify({
        letsencrypt: {
          Certificates: [
            {
              domain: { main: 'other.example.com' },
              certificate: Buffer.from(certPem).toString('base64'),
              key: '',
            },
          ],
        },
      }),
    );

    const cert = await getCertificateForDomain('missing.example.com');
    expect(cert).toBeNull();
  });

  it('returns certificate info when domain matches', async () => {
    const certPem = generateSelfSignedCert('found.example.com');
    writeFileSync(
      acmeFile,
      JSON.stringify({
        letsencrypt: {
          Certificates: [
            {
              domain: { main: 'found.example.com' },
              certificate: Buffer.from(certPem).toString('base64'),
              key: '',
            },
          ],
        },
      }),
    );

    const cert = await getCertificateForDomain('found.example.com');
    expect(cert).not.toBeNull();
    expect(cert!.domain).toBe('found.example.com');
  });
});

// ── Helper: generate a self-signed certificate for testing ────────────────────

function generateSelfSignedCert(cn: string): string {
  const { execSync } = require('node:child_process');
  // Use openssl to generate a self-signed cert in PEM format
  const result = execSync(
    `openssl req -x509 -newkey rsa:1024 -keyout /dev/null -out /dev/stdout -days 365 -nodes -subj "/CN=${cn}" 2>/dev/null`,
    { encoding: 'utf-8' },
  );
  return result;
}
