import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from './audit/audit.service.js';
import { connectorConfigSchema } from './config/config.schema.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { buildApp } from './server.js';

describe('buildApp database timeout handling', () => {
  it('returns 503 when PostgreSQL cancels a query at the configured bound', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kasbly-connector-audit-'));
    const auditFile = join(auditDir, 'audit.log');
    const config = connectorConfigSchema.parse({
      version: 1,
      auth: { apiKeys: [{ key: 'test-key', label: 'test' }] },
      database: {
        type: 'postgres',
        host: 'database.internal',
        database: 'inventory',
        user: 'connector',
        password: 'password',
        statementTimeoutMs: 100,
      },
      resources: {
        inventory: {
          table: 'cars',
          idColumn: 'id',
          fields: { externalId: 'id' },
        },
      },
      audit: { enabled: true, filePath: auditFile, maxFileSizeMB: 50, retentionDays: 90 },
    });
    const timeoutError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const dbAdapter: DatabaseAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn().mockRejectedValue(timeoutError),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      healthCheck: vi.fn(),
      introspect: vi.fn(),
    };
    const app = await buildApp({ config, dbAdapter });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/inventory',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      await app.close();
    }

    try {
      const [entry] = (await readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AuditEntry);
      expect(entry).toMatchObject({ method: 'GET', path: '/inventory', status: 503, items: 0 });
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  it('audits requests rejected by the API key guard', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kasbly-connector-audit-'));
    const auditFile = join(auditDir, 'audit.log');
    const config = connectorConfigSchema.parse({
      version: 1,
      auth: { apiKeys: [{ key: 'test-key', label: 'test' }] },
      database: {
        type: 'postgres',
        host: 'database.internal',
        database: 'inventory',
        user: 'connector',
        password: 'password',
      },
      resources: { inventory: { table: 'cars', idColumn: 'id', fields: { externalId: 'id' } } },
      audit: { enabled: true, filePath: auditFile, maxFileSizeMB: 50, retentionDays: 90 },
    });
    const dbAdapter: DatabaseAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn(),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      healthCheck: vi.fn(),
      introspect: vi.fn(),
    };
    const app = await buildApp({ config, dbAdapter });
    try {
      const response = await app.inject({ method: 'GET', url: '/inventory' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }

    try {
      const [entry] = (await readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AuditEntry);
      expect(entry).toMatchObject({
        method: 'GET',
        path: '/inventory',
        apiKey: 'unknown',
        status: 401,
        items: 0,
      });
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});
