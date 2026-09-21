import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from './audit/audit.service.js';
import { connectorConfigSchema } from './config/config.schema.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { buildApp } from './server.js';

describe('buildApp database timeout handling', () => {
  it('limits audit-log requests without limiting inventory requests', async () => {
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
      resources: {
        inventory: {
          table: 'cars',
          idColumn: 'id',
          fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
        },
      },
      audit: { enabled: true, filePath: auditFile, maxFileSizeMB: 50, retentionDays: 90 },
    });
    const dbAdapter: DatabaseAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [], total: 0, totalIsCapped: false }),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      probeSearchableColumns: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      introspect: vi.fn(),
    };
    const app = await buildApp({ config, dbAdapter });
    try {
      const auditLogRequests = [];
      for (let request = 0; request < 11; request++) {
        auditLogRequests.push(
          await app.inject({
            method: 'GET',
            url: '/audit-log',
            headers: { 'x-api-key': 'test-key' },
          }),
        );
      }

      expect(auditLogRequests.slice(0, 10).map((response) => response.statusCode)).toEqual(
        Array.from({ length: 10 }, () => 200),
      );
      expect(auditLogRequests[10]?.statusCode).toBe(429);

      const inventoryResponse = await app.inject({
        method: 'GET',
        url: '/inventory',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(inventoryResponse.statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(auditDir, { recursive: true, force: true });
    }
  });

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
          fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
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
      probeSearchableColumns: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      introspect: vi.fn(),
    };
    const app = await buildApp({
      config,
      dbAdapter,
      getResourceHealth: vi.fn().mockResolvedValue({ ok: true }),
    });
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
      resources: {
        inventory: {
          table: 'cars',
          idColumn: 'id',
          fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
        },
      },
      audit: { enabled: true, filePath: auditFile, maxFileSizeMB: 50, retentionDays: 90 },
    });
    const dbAdapter: DatabaseAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn(),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      probeSearchableColumns: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
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

// #27937: the Docker Compose healthcheck hits `/health` with no API key every 30s
// (2,880 times/day). The audit hook used to log every response including those
// probes, so `GET /audit-log`'s bounded newest-first scan filled up with
// `path: "/health"` rows and buried real API traffic within hours of uptime.
// `/health` is exempt from the audit log the same way it's exempt from the API-key
// guard (`isApiKeyExempt` in `auth/api-key.guard.ts`) — liveness is already surfaced
// via `GET /diagnostics` (`audit: ok | degraded`).
describe('onResponse audit hook', () => {
  function buildConfig(auditFile: string) {
    return connectorConfigSchema.parse({
      version: 1,
      auth: { apiKeys: [{ key: 'test-key', label: 'test' }] },
      database: {
        type: 'postgres',
        host: 'database.internal',
        database: 'inventory',
        user: 'connector',
        password: 'password',
      },
      resources: {
        inventory: {
          table: 'cars',
          idColumn: 'id',
          fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
        },
      },
      audit: { enabled: true, filePath: auditFile, maxFileSizeMB: 50, retentionDays: 90 },
    });
  }

  function buildHealthyAdapter(): DatabaseAdapter {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [], total: 0, totalIsCapped: false }),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      probeSearchableColumns: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      introspect: vi.fn(),
    };
  }

  it('does not append an audit line for /health, but still audits /inventory', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kasbly-connector-audit-'));
    const auditFile = join(auditDir, 'audit.log');
    const app = await buildApp({
      config: buildConfig(auditFile),
      dbAdapter: buildHealthyAdapter(),
    });
    try {
      const healthResponse = await app.inject({ method: 'GET', url: '/health' });
      expect(healthResponse.statusCode).toBe(200);

      const inventoryResponse = await app.inject({
        method: 'GET',
        url: '/inventory',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(inventoryResponse.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    try {
      const entries = (await readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AuditEntry);
      expect(entries.some((entry) => entry.path === '/health')).toBe(false);
      expect(entries).toContainEqual(
        expect.objectContaining({ method: 'GET', path: '/inventory', status: 200 }),
      );
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  it('does not create an audit file at all when every request is a /health probe', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kasbly-connector-audit-'));
    const auditFile = join(auditDir, 'audit.log');
    const app = await buildApp({
      config: buildConfig(auditFile),
      dbAdapter: buildHealthyAdapter(),
    });
    try {
      for (let probe = 0; probe < 5; probe++) {
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      // onClose flushes the audit write queue — closing first confirms /health
      // never enqueued a write in the first place.
      await app.close();
    }

    expect(existsSync(auditFile)).toBe(false);
    await rm(auditDir, { recursive: true, force: true });
  });
});

// #26697: `/health` is the one route the API-key guard deliberately skips
// (`auth/api-key.guard.ts`), so it must never carry the driver error text,
// schema/table name, or mapped column list a failed probe would otherwise
// produce. `/diagnostics` carries that detail, gated by the same guard that
// protects `/inventory` and `/audit-log`.
describe('health and diagnostics auth boundary', () => {
  function buildConfig() {
    return connectorConfigSchema.parse({
      version: 1,
      auth: { apiKeys: [{ key: 'test-key', label: 'test' }] },
      database: {
        type: 'postgres',
        host: 'database.internal',
        database: 'inventory',
        user: 'connector',
        password: 'password',
      },
      resources: {
        inventory: {
          table: 'cars',
          idColumn: 'id',
          fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
        },
      },
    });
  }

  function buildMisconfiguredAdapter(): DatabaseAdapter {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      query: vi.fn().mockRejectedValue(new Error('column "price" does not exist')),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      probeSearchableColumns: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      introspect: vi.fn(),
    };
  }

  it('serves a liveness-only body from /health with no API key, even when the resource probe fails', async () => {
    const app = await buildApp({ config: buildConfig(), dbAdapter: buildMisconfiguredAdapter() });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 'degraded',
        database: 'connected',
        resources: 'misconfigured',
      });
      expect(response.json()).not.toHaveProperty('resourceError');
    } finally {
      await app.close();
    }
  });

  it('rejects an unauthenticated /diagnostics request the same way as any other protected route', async () => {
    const app = await buildApp({ config: buildConfig(), dbAdapter: buildMisconfiguredAdapter() });
    try {
      const response = await app.inject({ method: 'GET', url: '/diagnostics' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Missing or invalid X-API-Key header' });
    } finally {
      await app.close();
    }
  });

  it('serves the full diagnostic detail from /diagnostics with a valid API key', async () => {
    const app = await buildApp({ config: buildConfig(), dbAdapter: buildMisconfiguredAdapter() });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/diagnostics',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 'degraded',
        database: 'connected',
        resources: 'misconfigured',
        resourceError: expect.stringContaining('column "price" does not exist'),
      });
    } finally {
      await app.close();
    }
  });
});
