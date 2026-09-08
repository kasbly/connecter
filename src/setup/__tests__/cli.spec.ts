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

  function mockConnector(
    distinctStatuses: unknown[],
    rows: Record<string, unknown>[] = [
      { id: '1', title: 'Test', price: 100, availability: 'for_sale' },
    ],
    extraFields: Record<string, string> = {},
  ): DatabaseAdapter {
    const dbAdapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        rows,
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
          fields: {
            title: 'title',
            price: 'price',
            currency: "'SAR'",
            status: 'availability',
            ...extraFields,
          },
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
      wireContractViolationIds: [],
      unservableImageIds: [],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"under_offer"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RESERVED'));
    expect(dbAdapter.disconnect).toHaveBeenCalled();
  }, 15_000);

  it('stays quiet when every source status value is mapped', async () => {
    mockConnector(['for_sale']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await validateConnectorConfig(packageJsonPath);

    expect(result.unknownStatusValues).toEqual([]);
    expect(result.wireContractViolationIds).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about sampled listings withheld for a broken wire contract', async () => {
    const dbAdapter = mockConnector(
      ['for_sale'],
      [
        { id: '1', title: 'Valid listing', price: 100, availability: 'for_sale' },
        { id: '42', title: 'Broken listing', price: null, availability: 'for_sale' },
      ],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await validateConnectorConfig(packageJsonPath);

    expect(result).toEqual({
      unknownStatusValues: [],
      unknownStatusPolicy: 'RESERVED',
      wireContractViolationIds: ['42'],
      unservableImageIds: [],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"42"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('withheld from customers'));
    expect(dbAdapter.disconnect).toHaveBeenCalled();
  }, 15_000);

  it('reports relative image paths as an advisory rather than failing validation', async () => {
    // Every sampled row carries a site-relative path — the WordPress shape.
    // Before #25790 the probe threw here, which is what 503'd the resource and
    // made `npm run setup` refuse to write the config.
    const dbAdapter = mockConnector(
      ['for_sale'],
      [
        {
          id: '1',
          title: 'Valid listing',
          price: 100,
          availability: 'for_sale',
          image_urls: '/wp-content/uploads/2026/03/car-123.jpg',
        },
        {
          id: '2',
          title: 'Another listing',
          price: 200,
          availability: 'for_sale',
          image_urls: 'car-456.jpg',
        },
      ],
      { images: 'image_urls' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await validateConnectorConfig(packageJsonPath);

    expect(result).toEqual({
      unknownStatusValues: [],
      unknownStatusPolicy: 'RESERVED',
      wireContractViolationIds: [],
      unservableImageIds: ['1', '2'],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('absolute http(s) URLs'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('withheld from customers'));
    expect(dbAdapter.disconnect).toHaveBeenCalled();
  }, 15_000);
});
