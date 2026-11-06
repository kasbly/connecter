import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { connectorConfigSchema } from './config/config.schema.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { startConnector } from './index.js';
import { buildApp } from './server.js';

describe('CURRENT_CONNECTOR_VERSION pin', () => {
  it('matches the services/connector tree SHA', () => {
    // Keep this equal to the short tree SHA of services/connector
    // (`git rev-parse HEAD:services/connector | cut -c1-7`), which is exactly
    // what sync-connector.yml stamps into the public mirror's version.json.
    // A tree SHA depends only on the directory's contents, so any PR touching
    // services/connector sets the pin in the same commit and it survives
    // rebases (#32980, #35313, #36156).
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const contentVersion = execFileSync('git', ['rev-parse', 'HEAD:services/connector'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .slice(0, 7);
    expect(contentVersion).toMatch(/^[a-f0-9]{7}$/);

    const pinSource = readFileSync(
      fileURLToPath(
        new URL(
          '../../../apps/api/src/modules/inventory/providers/connector.provider.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const pinMatch = pinSource.match(/CURRENT_CONNECTOR_VERSION = '([a-f0-9]+)'/);
    expect(pinMatch?.[1]).toBe(contentVersion);
  });
});

describe('startConnector', () => {
  it('keeps health diagnostics reachable when the initial mapping probe fails', async () => {
    const config = connectorConfigSchema.parse({
      version: 1,
      server: { port: 4000, host: '127.0.0.1' },
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
      audit: { enabled: false },
    });
    const dbAdapter: DatabaseAdapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockRejectedValue(new Error('column "price" does not exist')),
      queryById: vi.fn(),
      queryRelation: vi.fn(),
      probeSearchableColumns: vi.fn(),
      introspect: vi.fn(),
    };
    let listen = vi.fn();
    const buildAppWithoutNetwork = vi.fn(async (deps) => {
      const app = await buildApp(deps);
      listen = vi.spyOn(app, 'listen').mockResolvedValue(undefined);
      return app;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = await startConnector({
      configPath: 'test-connector.config.yml',
      dependencies: {
        validateConfigPath: vi.fn().mockResolvedValue(undefined),
        loadConfig: vi.fn(() => config),
        createDatabaseAdapter: vi.fn(() => dbAdapter),
        buildApp: buildAppWithoutNetwork,
      },
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      // `/health` has no API key at all (#26697), so the diagnostic detail
      // this test cares about is read from the authenticated `/diagnostics`
      // route instead — that is what "reachable" means once the probe fails.
      const diagnosticsResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics',
        headers: { 'x-api-key': 'test-key' },
      });
      const inventoryResponse = await app.inject({
        method: 'GET',
        url: '/inventory',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(listen).toHaveBeenCalledWith({ port: 4000, host: '127.0.0.1' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ database: 'connected', resources: 'misconfigured' });
      expect(response.json()).not.toHaveProperty('resourceError');
      expect(diagnosticsResponse.statusCode).toBe(503);
      expect(diagnosticsResponse.json()).toMatchObject({
        database: 'connected',
        resources: 'misconfigured',
        resourceError: expect.stringContaining('column "price" does not exist'),
      });
      expect(inventoryResponse.statusCode).toBe(503);
      expect(inventoryResponse.json()).toEqual({ error: 'Inventory resource is not ready' });
    } finally {
      error.mockRestore();
      await app.close();
    }
  });
});
