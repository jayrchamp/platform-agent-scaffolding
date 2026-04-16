// ── Connectivity + PostgreSQL Validation Flow Tests ─────────────────────────
//
// Story 19.5: Integration tests covering TCP check → PG check flow
// and error classification chains.

import { describe, it, expect } from 'vitest';
import { classifyConnectivityError } from '../src/services/connectivity.js';
import { classifyPgError } from '../src/services/postgres.js';

describe('Connectivity + PostgreSQL validation flow', () => {
  describe('Error classification chains', () => {
    it('TCP ECONNREFUSED → connectivity says connection_refused', () => {
      const err = new Error('connect ECONNREFUSED');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      expect(classifyConnectivityError(err)).toBe('connection_refused');
    });

    it('TCP succeeds but PG auth fails → PG says auth_failure', () => {
      // TCP would succeed (we don't test that here), then PG check runs
      const pgErr = Object.assign(
        new Error('password authentication failed for user "admin"'),
        { code: '28P01' }
      );
      expect(classifyPgError(pgErr)).toBe('auth_failure');
    });

    it('TCP succeeds but PG database not found → PG says database_not_found', () => {
      const pgErr = Object.assign(
        new Error('database "nonexistent" does not exist'),
        { code: '3D000' }
      );
      expect(classifyPgError(pgErr)).toBe('database_not_found');
    });

    it('TCP succeeds but PG pg_hba rejects → PG says pg_hba_rejected', () => {
      expect(
        classifyPgError(new Error('no pg_hba.conf entry for host "10.114.0.2"'))
      ).toBe('pg_hba_rejected');
    });

    it('TCP timeout → connectivity says timeout', () => {
      const err = new Error('Connection timed out after 5000ms');
      expect(classifyConnectivityError(err)).toBe('timeout');
    });

    it('TCP host unreachable → connectivity says host_unreachable', () => {
      const err = new Error('host unreachable') as NodeJS.ErrnoException;
      err.code = 'EHOSTUNREACH';
      expect(classifyConnectivityError(err)).toBe('host_unreachable');
    });
  });

  describe('Error classification completeness', () => {
    it('all connectivity error types return non-empty strings', () => {
      const errors = [
        Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
        Object.assign(new Error(''), { code: 'EHOSTUNREACH' }),
        Object.assign(new Error(''), { code: 'ENETUNREACH' }),
        Object.assign(new Error(''), { code: 'ENOTFOUND' }),
        new Error('timed out'),
        new Error('something unknown'),
      ];

      for (const err of errors) {
        const result = classifyConnectivityError(err);
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
      }
    });

    it('all PG error types return non-empty strings', () => {
      const errors = [
        Object.assign(new Error(''), { code: '28P01' }),
        Object.assign(new Error(''), { code: '3D000' }),
        new Error('ECONNREFUSED'),
        new Error('timed out'),
        new Error('SSL required'),
        new Error('no pg_hba.conf entry'),
        new Error('unknown issue'),
      ];

      for (const err of errors) {
        const result = classifyPgError(err);
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
      }
    });
  });
});
