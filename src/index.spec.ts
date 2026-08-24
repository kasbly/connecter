import { describe, expect, it, vi } from 'vitest';
import { connectorConfigSchema } from './config/config.schema.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { startConnector } from './index.js';
import { buildApp } from './server.js';

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
      const inventoryResponse = await app.inject({
        method: 'GET',
        url: '/inventory',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(listen).toHaveBeenCalledWith({ port: 4000, host: '127.0.0.1' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
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
