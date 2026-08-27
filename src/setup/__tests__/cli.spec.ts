import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '../../config/config.types.js';
import type { DatabaseAdapter } from '../../db/adapter.interface.js';
import { getCliCommand, validateConnectorConfig } from '../cli.js';

const packageJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createDatabaseAdapter: vi.fn(),
}));

vi.mock('../../config/config.loader.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../db/adapter.factory.js', () => ({
  createDatabaseAdapter: mocks.createDatabaseAdapter,
}));

describe('connector setup CLI', () => {
  it('dispatches the setup subcommand to the wizard', () => {
    expect(getCliCommand(['setup'])).toBe('setup');
  });

  it('keeps a bare CLI invocation on the server path', () => {
    expect(getCliCommand([])).toBe('start');
  });

  it('dispatches the validate subcommand without starting the server', () => {
    expect(getCliCommand(['validate'])).toBe('validate');
  });

  it('passes the setup subcommand from the documented npm script', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['setup']).toBe('tsx src/setup/cli.ts setup');
    expect(packageJson.scripts['validate']).toBe('tsx src/setup/cli.ts validate');
  });
});

describe('validate reporting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockReset();
    mocks.createDatabaseAdapter.mockReset();
  });

  function mockConnector(distinctStatuses: unknown[]): DatabaseAdapter {
    const dbAdapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', title: 'Test', price: 100, availability: 'for_sale' }],
        total: 10_000,
      }),
      distinctValues: vi.fn().mockResolvedValue(distinctStatuses),
    } as unknown as DatabaseAdapter;
    mocks.createDatabaseAdapter.mockReturnValue(dbAdapter);
    mocks.loadConfig.mockReturnValue({
      resources: {
        inventory: {
          table: 'inventory',
          idColumn: 'id',
          fields: { title: 'title', price: 'price', currency: "'SAR'", status: 'availability' },
          statusValues: { ACTIVE: ['for_sale'] },
          unknownStatusPolicy: 'RESERVED',
        },
      },
    } as unknown as ConnectorConfig);
    return dbAdapter;
  }

  it('reports source status values the merchant has not mapped', async () => {
    const dbAdapter = mockConnector(['for_sale', 'under_offer']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await validateConnectorConfig(packageJsonPath);

    expect(result).toEqual({
      unknownStatusValues: ['under_offer'],
      unknownStatusPolicy: 'RESERVED',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"under_offer"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RESERVED'));
    expect(dbAdapter.disconnect).toHaveBeenCalled();
  });

  it('stays quiet when every source status value is mapped', async () => {
    mockConnector(['for_sale']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await validateConnectorConfig(packageJsonPath);

    expect(result.unknownStatusValues).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
