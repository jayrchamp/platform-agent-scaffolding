// ── PostgreSQL Test Connection — Service Tests ─────────────────────────────
//
// Tests for testPgConnection and classifyPgError (Story 19.4).

import { describe, it, expect, vi } from 'vitest';
import { classifyPgError } from '../src/services/postgres.js';

// testPgConnection needs a real Pool — we test it via route tests with mocked pg.
// Here we focus on classifyPgError which is pure.

describe('classifyPgError', () => {
  it('classifies password authentication failure (code 28P01)', () => {
    const err = Object.assign(
      new Error('password authentication failed for user "admin"'),
      {
        code: '28P01',
      }
    );
    expect(classifyPgError(err)).toBe('auth_failure');
  });

  it('classifies password auth failure by message (no code)', () => {
    expect(classifyPgError(new Error('password authentication failed'))).toBe(
      'auth_failure'
    );
  });

  it('classifies database not found (code 3D000)', () => {
    const err = Object.assign(
      new Error('database "nonexistent" does not exist'),
      {
        code: '3D000',
      }
    );
    expect(classifyPgError(err)).toBe('database_not_found');
  });

  it('classifies database not found by message', () => {
    expect(classifyPgError(new Error('database "x" does not exist'))).toBe(
      'database_not_found'
    );
  });

  it('classifies connection refused', () => {
    expect(
      classifyPgError(new Error('connect ECONNREFUSED 10.0.0.1:5432'))
    ).toBe('connection_refused');
  });

  it('classifies timeout', () => {
    expect(classifyPgError(new Error('Connection timed out'))).toBe('timeout');
  });

  it('classifies SSL required', () => {
    expect(classifyPgError(new Error('SSL connection is required'))).toBe(
      'ssl_required'
    );
  });

  it('classifies pg_hba rejection', () => {
    expect(
      classifyPgError(
        new Error('no pg_hba.conf entry for host "10.0.0.1", user "admin"')
      )
    ).toBe('pg_hba_rejected');
  });

  it('classifies unknown errors', () => {
    expect(classifyPgError(new Error('something else'))).toBe(
      'unknown: something else'
    );
  });

  it('handles non-Error values', () => {
    expect(classifyPgError('oops')).toBe('unknown: oops');
  });
});
