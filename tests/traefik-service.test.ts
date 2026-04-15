// ── Traefik Service Tests ──────────────────────────────────────────────────────
//
// Tests for the Traefik dynamic route management service.
// Uses real filesystem (temp dir) for route config tests
// and mocked acme.json for certificate parsing tests.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

import {
  writeRouteConfig,
  removeRouteConfig,
  listRouteConfigs,
  getCertificates,
  getCertificateForDomain,
  writeOriginCert,
  removeOriginCert,
  listOriginCerts,
  setTraefikPaths,
  resetTraefikPaths,
} from '../src/services/traefik.js';

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let dynamicDir: string;
let acmeFile: string;
let originCertsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'platform-traefik-'));
  dynamicDir = join(tmpDir, 'dynamic');
  acmeFile = join(tmpDir, 'acme.json');
  originCertsDir = join(tmpDir, 'origin');
  mkdirSync(dynamicDir, { recursive: true });
  setTraefikPaths({ dynamicDir, acmeFile, originCertsDir });
});

afterAll(() => {
  resetTraefikPaths();
});

// ── writeRouteConfig ──────────────────────────────────────────────────────────

describe('writeRouteConfig', () => {
  it('creates a valid YAML file with correct structure', async () => {
    await writeRouteConfig(
      'my-app',
      'app.example.com',
      'my-app-web-abc123',
      3000
    );

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
    expect(routers['my-app-http'].middlewares).toEqual([
      'my-app-redirect-https',
    ]);

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
      'http://new-container:8080'
    );
  });

  it('does not leave temp files after write', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'container', 3000);

    const files = require('node:fs').readdirSync(dynamicDir);
    expect(files).toEqual(['my-app.yml']);
    expect(files.some((f: string) => f.endsWith('.tmp'))).toBe(false);
  });

  it('handles app names with hyphens and numbers', async () => {
    await writeRouteConfig(
      'my-app-2',
      'app2.example.com',
      'my-app-2-web-def456',
      4000
    );

    const filePath = join(dynamicDir, 'my-app-2.yml');
    expect(existsSync(filePath)).toBe(true);

    const parsed = yaml.load(readFileSync(filePath, 'utf-8')) as any;
    expect(parsed.http.routers['my-app-2'].rule).toBe(
      'Host(`app2.example.com`)'
    );
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
    await writeRouteConfig(
      'app-one',
      'one.example.com',
      'app-one-web-aaa',
      3000
    );
    await writeRouteConfig(
      'app-two',
      'two.example.com',
      'app-two-web-bbb',
      4000
    );

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
      })
    );

    const certs = await getCertificates();
    expect(certs).toEqual([]);
  });

  it('parses certificates from acme.json', async () => {
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
      })
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
      })
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
      })
    );

    const cert = await getCertificateForDomain('found.example.com');
    expect(cert).not.toBeNull();
    expect(cert!.domain).toBe('found.example.com');
  });
});

// ── writeRouteConfig with sslMode ─────────────────────────────────────────────

describe('writeRouteConfig sslMode', () => {
  it('generates letsencrypt certResolver by default', async () => {
    await writeRouteConfig('my-app', 'app.example.com', 'container', 3000);

    const content = readFileSync(join(dynamicDir, 'my-app.yml'), 'utf-8');
    const parsed = yaml.load(content) as any;

    expect(parsed.http.routers['my-app'].tls.certResolver).toBe('letsencrypt');
    expect(parsed.tls).toBeUndefined();
  });

  it('generates origin mode with tls.certificates section', async () => {
    await writeRouteConfig(
      'my-app',
      'app.example.com',
      'container',
      3000,
      'origin'
    );

    const content = readFileSync(join(dynamicDir, 'my-app.yml'), 'utf-8');
    const parsed = yaml.load(content) as any;

    // Router should have empty tls (no certResolver)
    expect(parsed.http.routers['my-app'].tls).toEqual({});
    expect(parsed.http.routers['my-app'].tls.certResolver).toBeUndefined();

    // Root tls.certificates should reference origin cert files
    expect(parsed.tls).toBeDefined();
    expect(parsed.tls.certificates).toHaveLength(1);
    expect(parsed.tls.certificates[0].certFile).toBe(
      '/certs/origin/app.example.com.crt'
    );
    expect(parsed.tls.certificates[0].keyFile).toBe(
      '/certs/origin/app.example.com.key'
    );
  });

  it('still includes HTTP redirect middleware in origin mode', async () => {
    await writeRouteConfig(
      'my-app',
      'app.example.com',
      'container',
      3000,
      'origin'
    );

    const parsed = yaml.load(
      readFileSync(join(dynamicDir, 'my-app.yml'), 'utf-8')
    ) as any;

    expect(parsed.http.routers['my-app-http']).toBeDefined();
    expect(parsed.http.routers['my-app-http'].middlewares).toEqual([
      'my-app-redirect-https',
    ]);
    expect(parsed.http.middlewares['my-app-redirect-https']).toBeDefined();
  });
});

// ── writeOriginCert ───────────────────────────────────────────────────────────

describe('writeOriginCert', () => {
  const CERT_PEM =
    '-----BEGIN CERTIFICATE-----\nTEST_CERT\n-----END CERTIFICATE-----';
  const KEY_PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nTEST_KEY\n-----END RSA PRIVATE KEY-----';

  it('creates cert and key files', async () => {
    await writeOriginCert('app.example.com', CERT_PEM, KEY_PEM);

    const certFile = join(originCertsDir, 'app.example.com.crt');
    const keyFile = join(originCertsDir, 'app.example.com.key');

    expect(existsSync(certFile)).toBe(true);
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(certFile, 'utf-8')).toBe(CERT_PEM);
    expect(readFileSync(keyFile, 'utf-8')).toBe(KEY_PEM);
  });

  it('creates the origin certs directory if missing', async () => {
    const newDir = join(tmpDir, 'new-origin');
    setTraefikPaths({ originCertsDir: newDir });

    await writeOriginCert('test.com', CERT_PEM, KEY_PEM);
    expect(existsSync(join(newDir, 'test.com.crt'))).toBe(true);
  });

  it('overwrites existing cert files', async () => {
    await writeOriginCert('app.example.com', 'OLD_CERT', 'OLD_KEY');
    await writeOriginCert('app.example.com', CERT_PEM, KEY_PEM);

    expect(
      readFileSync(join(originCertsDir, 'app.example.com.crt'), 'utf-8')
    ).toBe(CERT_PEM);
    expect(
      readFileSync(join(originCertsDir, 'app.example.com.key'), 'utf-8')
    ).toBe(KEY_PEM);
  });
});

// ── removeOriginCert ──────────────────────────────────────────────────────────

describe('removeOriginCert', () => {
  const CERT_PEM =
    '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';
  const KEY_PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----';

  it('removes cert and key files', async () => {
    await writeOriginCert('app.example.com', CERT_PEM, KEY_PEM);
    await removeOriginCert('app.example.com');

    expect(existsSync(join(originCertsDir, 'app.example.com.crt'))).toBe(false);
    expect(existsSync(join(originCertsDir, 'app.example.com.key'))).toBe(false);
  });

  it('does not throw when files do not exist', async () => {
    await expect(removeOriginCert('nonexistent.com')).resolves.toBeUndefined();
  });
});

// ── listOriginCerts ───────────────────────────────────────────────────────────

describe('listOriginCerts', () => {
  const CERT_PEM =
    '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';
  const KEY_PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----';

  it('returns empty array when no certs exist', async () => {
    const result = await listOriginCerts();
    expect(result).toEqual([]);
  });

  it('returns empty array when directory does not exist', async () => {
    setTraefikPaths({ originCertsDir: join(tmpDir, 'nonexistent') });
    const result = await listOriginCerts();
    expect(result).toEqual([]);
  });

  it('lists paired cert/key files', async () => {
    await writeOriginCert('a.example.com', CERT_PEM, KEY_PEM);
    await writeOriginCert('b.example.com', CERT_PEM, KEY_PEM);

    const result = await listOriginCerts();
    expect(result).toHaveLength(2);

    const domains = result.map((r) => r.domain).sort();
    expect(domains).toEqual(['a.example.com', 'b.example.com']);
  });

  it('skips unpaired files', async () => {
    await writeOriginCert('paired.com', CERT_PEM, KEY_PEM);
    // Write only a .crt with no matching .key
    writeFileSync(join(originCertsDir, 'orphan.com.crt'), CERT_PEM);

    const result = await listOriginCerts();
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe('paired.com');
  });
});

// ── Helper: generate a self-signed certificate for testing ────────────────────
// Returns a static self-signed PEM certificate so tests don't depend on openssl
// being installed (it's absent in CI).  The service reads the domain from the
// ACME JSON `domain.main` field, not from the certificate's CN, so using a
// single static cert for all test domains is fine.

function generateSelfSignedCert(_cn: string): string {
  return STATIC_SELF_SIGNED_PEM;
}

// A real self-signed X.509 certificate (RSA 2048, valid 2026-2036, CN=localhost).
const STATIC_SELF_SIGNED_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDCTCCAfGgAwIBAgIUfXtV3OGmvvIwUpmP6hBEHt9WAUcwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDQxNTE2MDA0OFoXDTM2MDQx',
  'MjE2MDA0OFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF',
  'AAOCAQ8AMIIBCgKCAQEAyp1z3SBbbCAJ+NMNieFwE5mJnFl7N9+UVcH0lQQ+8Tti',
  'h6dNH73+cqDOcDMOTR6NWEoM5XP3bNfxFqk+LGO+MXhpaZfZy3CUy/efPai0REJB',
  'gQb9DUjZOigHgY0GsYpwzwGybF/IlCU4L88lnK/BtoM00odbfMJs+u+79bfNztkE',
  'atBODmHM3AddON6Assy56Kc/IH1TjoayRiVTPMGbzy1mZSV2IiP9qUyS4s04o92x',
  'mHn7wy+LkC73YBccqN8B3ZTvvLsrXhRa9rp+E7oDJOeoADfjizDlb8DzQoFJ1G75',
  'kQZGerbOI/H6OViWxIIoBOTPZR/KJC6M0B5zRmi1qwIDAQABo1MwUTAdBgNVHQ4E',
  'FgQUhFbEM5357blMK8cFxfyYdqltpBUwHwYDVR0jBBgwFoAUhFbEM5357blMK8cF',
  'xfyYdqltpBUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAG4I1',
  '6bR83mtUtIDLULrHfGPPa+Bv2wSEE3X43DWUzIvEoSyUiqEHZ5KMOtENNTNttNPS',
  '/YefrsvtFIlKwJ9MAueKRKZXSjFdEqKn2EfeYyOnpay1TO6/x/yC0h9ju3WPdAUj',
  'f0O6QbE9Y+cmTMo5bVSxLF5/qeRxfNSS9gwbif1yLZT/w2q2pY1Kg3ytx5IvJmPC',
  'a+2YlM6rqSHxET9dI0flYvSF/7VgrmP0rLeFFRi87dDT09y7UOWDBosRlTcCri0F',
  'iMFPToKhyGSEWBbQ8Wwk20RMPY28XJCQUrf/WfwCBOUJnhvoqvpMvwk1iqmsiOc1',
  '8iKiyJFaQlUKaDrqSw==',
  '-----END CERTIFICATE-----',
].join('\n');
