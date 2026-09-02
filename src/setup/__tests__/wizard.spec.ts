import { describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  FIELD_MAPPING_TARGETS,
  backupPrivateFile,
  getFieldMappingPrompt,
  getIdColumnPrompt,
  isPublicHostname,
  loadExistingSetupConfig,
  mergeEnvironmentFile,
  quoteIfNeeded,
  serializeEnvValue,
  shouldDefaultToTls,
  STATUS_VALUE_PROMPT_LIMIT,
  STATUS_VALUE_SCAN_LIMIT,
  toConfigLiteral,
  writePrivateFile,
} from '../wizard.js';
import { runWizard } from '../wizard.js';
import { buildQuery } from '../../mapping/query-builder.js';
import { mapRowToInventoryItem } from '../../mapping/field-mapper.js';
import { introspectDatabase } from '../introspect.js';
import { createDatabaseAdapter } from '../../db/adapter.factory.js';
import { probeInventoryResource } from '../../routes/health.route.js';

const promptMocks = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

const introspectionMocks = vi.hoisted(() => ({ introspectDatabase: vi.fn() }));
const resourceProbeMocks = vi.hoisted(() => {
  const adapter = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return {
    adapter,
    createDatabaseAdapter: vi.fn(() => adapter),
    probeInventoryResource: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@inquirer/prompts', () => promptMocks);
vi.mock('../introspect.js', () => introspectionMocks);
vi.mock('../../db/adapter.factory.js', () => ({
  createDatabaseAdapter: resourceProbeMocks.createDatabaseAdapter,
}));
vi.mock('../../routes/health.route.js', () => ({
  probeInventoryResource: resourceProbeMocks.probeInventoryResource,
}));

describe('getFieldMappingPrompt', () => {
  it('offers every column and preselects the matching suggestion', () => {
    const prompt = getFieldMappingPrompt(
      'title',
      ['id', 'product_title', 'unit_price'],
      'product_title',
    );

    expect(prompt.default).toBe('product_title');
    expect(prompt.choices).toContainEqual({
      name: 'product_title (suggested)',
      value: 'product_title',
    });
    expect(prompt.choices).toContainEqual({ name: 'unit_price', value: 'unit_price' });
  });

  it('only offers numeric columns for price mappings', () => {
    const prompt = getFieldMappingPrompt('price', [
      { name: 'name', type: 'text' },
      { name: 'formatted_price', type: 'varchar' },
      { name: 'amount', type: 'numeric' },
      { name: 'legacy_price', type: 'money' },
    ]);

    expect(prompt.choices.map((choice) => choice.value)).toContain('amount');
    expect(prompt.choices.map((choice) => choice.value)).not.toContain('formatted_price');
    expect(prompt.choices.map((choice) => choice.value)).not.toContain('legacy_price');
  });

  it('does not offer UUID columns for status mappings', () => {
    const prompt = getFieldMappingPrompt('status', [
      { name: 'id', type: 'uuid' },
      { name: 'availability', type: 'varchar' },
    ]);

    expect(prompt.choices.map((choice) => choice.value)).not.toContain('id');
    expect(prompt.choices.map((choice) => choice.value)).toContain('availability');
  });

  it('offers PostgreSQL enums and integer status codes', () => {
    const prompt = getFieldMappingPrompt('status', [
      { name: 'state', type: 'USER-DEFINED', udtName: 'listing_state' },
      { name: 'status_code', type: 'smallint' },
      { name: 'id', type: 'uuid' },
    ]);

    expect(prompt.choices.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(['state', 'status_code']),
    );
    expect(prompt.choices.map((choice) => choice.value)).not.toContain('id');
  });

  it('offers citext columns reported as user-defined for text field mappings', () => {
    const prompt = getFieldMappingPrompt('title', [
      { name: 'title', type: 'USER-DEFINED', udtName: 'citext' },
      { name: 'metadata', type: 'jsonb' },
    ]);

    expect(prompt.choices.map((choice) => choice.value)).toContain('title');
    expect(prompt.choices.map((choice) => choice.value)).not.toContain('metadata');
  });

  it.each(['title', 'currency', 'category', 'status'] as const)(
    'does not offer JSON columns for %s mappings',
    (field) => {
      const prompt = getFieldMappingPrompt(field, [
        { name: 'localized', type: 'jsonb' },
        { name: 'plain_text', type: 'text' },
      ]);

      expect(prompt.choices.map((choice) => choice.value)).not.toContain('localized');
      expect(prompt.choices.map((choice) => choice.value)).toContain('plain_text');
    },
  );

  it('continues to offer JSON columns for image mappings', () => {
    const prompt = getFieldMappingPrompt('images', [{ name: 'image_urls', type: 'jsonb' }]);

    expect(prompt.choices.map((choice) => choice.value)).toContain('image_urls');
  });

  it.each(['currency', 'category', 'status'] as const)('offers a fixed value for %s', (field) => {
    const prompt = getFieldMappingPrompt(field, ['id'], undefined);

    expect(prompt.choices).toContainEqual({
      name: 'Use a fixed value for every row',
      value: '\0fixed-value',
    });
  });

  it.each(
    FIELD_MAPPING_TARGETS.filter(
      (field) => field !== 'currency' && field !== 'category' && field !== 'status',
    ),
  )('does not offer a fixed value for %s', (field) => {
    expect(getFieldMappingPrompt(field, ['id']).choices.map((choice) => choice.name)).not.toContain(
      'Use a fixed value for every row',
    );
  });

  it('explains the accepted image formats with a sample', () => {
    const prompt = getFieldMappingPrompt('images', ['image_urls']);

    expect(prompt.message).toContain('PostgreSQL text array');
    expect(prompt.message).toContain('https://example.com/photo.jpg');
  });
});

describe('getIdColumnPrompt', () => {
  it('offers every column and preselects the matching suggestion', () => {
    const prompt = getIdColumnPrompt([{ name: 'sku' }, { name: 'id' }, { name: 'title' }], 'id');

    expect(prompt.message).toBe('Which column is the unique listing id?');
    expect(prompt.default).toBe('id');
    expect(prompt.choices).toEqual([
      { name: 'sku', value: 'sku' },
      { name: 'id (suggested)', value: 'id' },
      { name: 'title', value: 'title' },
    ]);
    expect(prompt.choices.map((choice) => choice.name)).not.toContain('Do not map this field');
  });

  it('omits a default when there is no suggested column', () => {
    const prompt = getIdColumnPrompt(
      [{ name: 'sku' }, { name: 'title' }, { name: 'price' }, { name: 'currency' }],
      null,
    );

    expect(prompt.default).toBeUndefined();
    expect(prompt.choices.map((choice) => choice.value)).toEqual([
      'sku',
      'title',
      'price',
      'currency',
    ]);
    expect(prompt.choices.map((choice) => choice.value)).not.toContain('id');
  });

  it('never invents an id choice or default when that column is not on the table', () => {
    const prompt = getIdColumnPrompt([{ name: 'sku' }, { name: 'title' }], 'id');

    expect(prompt.default).toBeUndefined();
    expect(prompt.choices).toEqual([
      { name: 'sku', value: 'sku' },
      { name: 'title', value: 'title' },
    ]);
  });
});

describe('toConfigLiteral', () => {
  it('produces the connector config literal form', () => {
    expect(toConfigLiteral('SAR')).toBe("'SAR'");
  });
});

describe('quoteIfNeeded', () => {
  it.each(['desc', 'order', 'user', 'limit', 'group'])(
    'quotes the PostgreSQL reserved word %s',
    (identifier) => {
      expect(quoteIfNeeded(identifier)).toBe(`"${identifier}"`);
    },
  );

  it('quotes ordinary identifiers and escapes embedded quotes', () => {
    expect(quoteIfNeeded('inventory_id')).toBe('"inventory_id"');
    expect(quoteIfNeeded('merchant"sku')).toBe('"merchant""sku"');
  });
});

describe('shouldDefaultToTls', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1'])(
    'does not default to TLS for %s',
    (host) => {
      expect(shouldDefaultToTls(host)).toBe(false);
    },
  );

  it('defaults to TLS for a remote database host', () => {
    expect(shouldDefaultToTls('postgres.example.com')).toBe(true);
  });
});

describe('isPublicHostname', () => {
  it('accepts a bare DNS name', () => {
    expect(isPublicHostname('connector.merchant.example')).toBe(true);
  });

  it.each(['https://connector.merchant.example', 'connector.merchant.example:443', '', '   '])(
    'rejects %j, which Caddy cannot serve a certificate for',
    (value) => {
      expect(isPublicHostname(value)).toBe(false);
    },
  );
});

describe('writePrivateFile', () => {
  it('creates and repairs generated files with owner-only permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const path = join(directory, '.env');
    try {
      writeFileSync(path, 'old', { mode: 0o644 });
      writePrivateFile(path, 'DB_PASSWORD=secret\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('backupPrivateFile', () => {
  it('creates an owner-only timestamped backup beside the original file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const path = join(directory, '.env');
    try {
      writeFileSync(path, 'CONNECTOR_PORT=4100\n', { mode: 0o644 });
      const backupPath = backupPrivateFile(path, new Date('2026-08-19T12:34:56.789Z'));
      expect(backupPath).toBe(`${path}.2026-08-19T12-34-56-789Z.bak`);
      expect(readFileSync(backupPath, 'utf-8')).toBe('CONNECTOR_PORT=4100\n');
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('mergeEnvironmentFile', () => {
  it('updates wizard-owned values without dropping existing operator settings', () => {
    expect(
      mergeEnvironmentFile('CONNECTOR_PORT=4100\nCUSTOM_SETTING=keep\n', {
        DB_HOST: 'database.internal',
        CONNECTOR_API_KEY: 'kc_existing',
      }),
    ).toBe(
      "CONNECTOR_PORT=4100\nCUSTOM_SETTING=keep\nDB_HOST='database.internal'\nCONNECTOR_API_KEY='kc_existing'\n",
    );
  });

  it('removes a retired pending key without changing unrelated operator settings', () => {
    expect(
      mergeEnvironmentFile('CUSTOM_SETTING=keep\nCONNECTOR_API_KEY_PENDING=kc_pending\n', {
        CONNECTOR_API_KEY_PENDING: null,
      }),
    ).toBe('CUSTOM_SETTING=keep\n');
  });
});

describe('loadExistingSetupConfig', () => {
  it('loads local .env values and preserves existing trusted proxy configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const configPath = join(directory, 'connector.config.yml');
    const envPath = join(directory, '.env');
    try {
      writeFileSync(envPath, 'DB_HOST=database.internal\nDB_PASSWORD=secret\n');
      writeFileSync(
        configPath,
        [
          'version: 1',
          'server:',
          '  port: 4100',
          '  host: 0.0.0.0',
          '  trustedProxies: 10.0.0.0/8',
          'auth:',
          '  apiKeys:',
          '    - key: key',
          '      label: test',
          'database:',
          '  type: postgres',
          '  host: ${DB_HOST}',
          '  database: inventory',
          '  user: reader',
          '  password: ${DB_PASSWORD}',
          'resources:',
          '  inventory:',
          '    table: products',
          '    idColumn: id',
          '    fields:',
          '      title: title',
          '      price: price',
          '      currency: currency',
          '',
        ].join('\n'),
      );
      const config = loadExistingSetupConfig(configPath, envPath);
      expect(config.database.host).toBe('database.internal');
      expect(config.server.trustedProxies).toBe('10.0.0.0/8');
      expect(process.env['DB_HOST']).toBeUndefined();
      expect(process.env['DB_PASSWORD']).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('serializeEnvValue', () => {
  it.each(['p@ss#word', 'my pass ', 'a"b#c', "a'b#c"])(
    'round-trips dotenv-significant value %j',
    (value) => {
      expect(parse(`DB_PASSWORD=${serializeEnvValue(value)}\n`).DB_PASSWORD).toBe(value);
    },
  );
});

describe('runWizard', () => {
  it('refuses an empty schema before showing the inventory-object selector', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = { destroy: vi.fn().mockResolvedValue(undefined) };

    vi.clearAllMocks();
    promptMocks.select.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Database type')) return Promise.resolve('postgres');
      throw new Error(`Unexpected select prompt: ${message}`);
    });
    promptMocks.input.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Host')) return Promise.resolve('database.example.com');
      if (message.startsWith('Port')) return Promise.resolve('5432');
      if (message.startsWith('Database name')) return Promise.resolve('catalog');
      if (message.startsWith('PostgreSQL schema')) return Promise.resolve('catalog');
      return Promise.resolve('reader');
    });
    promptMocks.password.mockResolvedValue('p@ss#word');
    promptMocks.confirm.mockResolvedValue(false);
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: { tables: [], foreignKeys: [] },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await expect(runWizard()).rejects.toThrow(
        'No tables or views in schema catalog — pick another schema.',
      );
      expect(db.destroy).toHaveBeenCalledOnce();
      expect(promptMocks.select).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Which table contains your products/inventory?' }),
      );
    } finally {
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes a loadable config from a materialized view whose quoted fields support bare sortBy values', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = Object.assign(vi.fn(), {
      destroy: vi.fn().mockResolvedValue(undefined),
      withSchema: vi.fn(() => ({
        table: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
      })),
    });

    promptMocks.select.mockImplementationOnce(() => Promise.resolve('postgres'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('products'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('id'));
    for (const answer of [
      'title',
      'price',
      'currency',
      '\0unmapped',
      '\0unmapped',
      'description',
      '\0unmapped',
    ]) {
      promptMocks.select.mockImplementationOnce(() => Promise.resolve(answer));
    }
    // Step 6 asks which proxy fronts the connector; take the bundled Caddy.
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('bundled'));
    for (const answer of [
      'database.example.com',
      '5432',
      'catalog',
      'reader',
      'merchant_data',
      'connector.merchant.example',
    ]) {
      promptMocks.input.mockImplementationOnce(() => Promise.resolve(answer));
    }
    promptMocks.password.mockResolvedValueOnce('p@ss#word');
    promptMocks.confirm.mockImplementation(({ message }) =>
      Promise.resolve(message.startsWith('Does this database require TLS') ? false : true),
    );
    promptMocks.checkbox.mockImplementation(({ message }) => {
      if (message.startsWith('Select additional')) return Promise.resolve([]);
      if (message.startsWith('Which columns should be searchable')) {
        return Promise.resolve(['title', 'description']);
      }
      if (message.startsWith('Which filters should be available')) {
        return Promise.resolve(['minPrice', 'maxPrice', 'currency']);
      }
      return Promise.resolve(['url']);
    });
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [
          {
            name: 'products',
            kind: 'materialized view',
            rowCount: 100,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'sku', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'title', type: 'character', nullable: false, isPrimaryKey: false },
              { name: 'price', type: 'numeric', nullable: false, isPrimaryKey: false },
              { name: 'currency', type: 'varchar', nullable: false, isPrimaryKey: false },
              { name: 'description', type: 'text', nullable: true, isPrimaryKey: false },
              { name: 'makeEn', type: 'text', nullable: true, isPrimaryKey: false },
              { name: 'year', type: 'integer', nullable: true, isPrimaryKey: false },
            ],
          },
          {
            name: 'product_images',
            kind: 'table',
            rowCount: 200,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'product_sku', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'url', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'sort_order', type: 'integer', nullable: false, isPrimaryKey: false },
            ],
          },
          {
            name: 'variant_images',
            kind: 'table',
            rowCount: 200,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'product_id', type: 'uuid', nullable: false, isPrimaryKey: false },
              { name: 'url', type: 'text', nullable: false, isPrimaryKey: false },
            ],
          },
        ],
        foreignKeys: [
          {
            fromTable: 'product_images',
            fromColumn: 'product_sku',
            toTable: 'products',
            toColumn: 'sku',
          },
          {
            fromTable: 'variant_images',
            fromColumn: 'product_id',
            toTable: 'products',
            toColumn: 'id',
          },
        ],
      },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await runWizard();

      const config = loadExistingSetupConfig(
        join(directory, 'connector.config.yml'),
        join(directory, '.env'),
      );
      expect(config.resources.inventory.fields.price).toBe('"price"');
      expect(config.resources.inventory.schema).toBe('merchant_data');
      expect(config.resources.inventory).not.toHaveProperty('attributes');
      // The bundled `docker compose up -d` the wizard recommends cannot resolve
      // without CONNECTOR_DOMAIN, and attributes every request to Caddy without
      // trustedProxies, so a fresh run has to emit both.
      expect(parse(readFileSync(join(directory, '.env'), 'utf-8'))['CONNECTOR_DOMAIN']).toBe(
        'connector.merchant.example',
      );
      expect(config.server.trustedProxies).toBe('172.30.0.2');
      expect(config.resources.inventory.relations?.product_images).toMatchObject({
        schema: 'merchant_data',
        imageUrlField: 'url',
        foreignKey: '"product_sku"',
        referenceKey: '"sku"',
      });
      expect(config.resources.inventory.relations?.variant_images).toMatchObject({
        schema: 'merchant_data',
        imageUrlField: 'url',
      });
      expect(
        mapRowToInventoryItem(
          { id: 'product-1', sku: 'sonata-2024', title: 'Product', price: 100, currency: 'SAR' },
          config.resources.inventory,
          new Map([
            [
              'product_images',
              new Map([['sonata-2024', [{ url: 'https://example.com/product.jpg' }]]]),
            ],
            [
              'variant_images',
              new Map([['product-1', [{ url: 'https://example.com/variant.jpg' }]]]),
            ],
          ]),
        ).images,
      ).toEqual(['https://example.com/product.jpg', 'https://example.com/variant.jpg']);
      expect(introspectionMocks.introspectDatabase).toHaveBeenCalledWith(
        expect.objectContaining({ schema: 'merchant_data' }),
      );
      expect(promptMocks.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Which table contains your products/inventory?',
          choices: expect.arrayContaining([
            { name: 'products (materialized view, 100 rows)', value: 'products' },
          ]),
        }),
      );
      expect(promptMocks.checkbox).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Which columns should be searchable? (full-text search)',
          choices: expect.arrayContaining([
            expect.objectContaining({ name: 'title', value: 'title' }),
          ]),
        }),
      );
      expect(buildQuery({ sortBy: 'price' }, config.resources.inventory).sort.column).toBe(
        config.resources.inventory.fields.price,
      );
      expect(createDatabaseAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'database.example.com',
          database: 'catalog',
          user: 'reader',
          password: 'p@ss#word',
        }),
      );
      expect(probeInventoryResource).toHaveBeenCalledWith(
        resourceProbeMocks.adapter,
        expect.objectContaining({
          schema: 'merchant_data',
          table: 'products',
          fields: config.resources.inventory.fields,
          relations: config.resources.inventory.relations,
        }),
      );
      expect(resourceProbeMocks.adapter.connect).toHaveBeenCalledOnce();
      expect(resourceProbeMocks.adapter.disconnect).toHaveBeenCalledOnce();
    } finally {
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes the operator-chosen unique listing id for a view with no id column', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = Object.assign(vi.fn(), {
      destroy: vi.fn().mockResolvedValue(undefined),
      withSchema: vi.fn(() => ({
        table: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
      })),
    });

    vi.clearAllMocks();
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('postgres'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('available_products'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('sku'));
    for (const answer of [
      'title',
      'price',
      'currency',
      '\0unmapped',
      '\0unmapped',
      '\0unmapped',
      '\0unmapped',
    ]) {
      promptMocks.select.mockImplementationOnce(() => Promise.resolve(answer));
    }
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('bundled'));
    for (const answer of [
      'database.example.com',
      '5432',
      'catalog',
      'reader',
      'merchant_data',
      'connector.merchant.example',
    ]) {
      promptMocks.input.mockImplementationOnce(() => Promise.resolve(answer));
    }
    promptMocks.password.mockResolvedValueOnce('p@ss#word');
    promptMocks.confirm.mockImplementation(({ message }) =>
      Promise.resolve(message.startsWith('Does this database require TLS') ? false : true),
    );
    promptMocks.checkbox.mockImplementation(({ message }) => {
      if (message.startsWith('Select additional')) return Promise.resolve([]);
      if (message.startsWith('Which columns should be searchable')) {
        return Promise.resolve(['title']);
      }
      return Promise.resolve([]);
    });
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [
          {
            name: 'available_products',
            kind: 'view',
            rowCount: 40,
            columns: [
              { name: 'sku', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'title', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'price', type: 'numeric', nullable: false, isPrimaryKey: false },
              { name: 'currency', type: 'varchar', nullable: false, isPrimaryKey: false },
            ],
          },
        ],
        foreignKeys: [],
      },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await runWizard();

      const generated = yaml.load(
        readFileSync(join(directory, 'connector.config.yml'), 'utf-8'),
      ) as {
        resources: { inventory: { idColumn: string; fields: Record<string, string> } };
      };
      const inventory = generated.resources.inventory;
      expect(inventory.idColumn).toBe('"sku"');
      expect(inventory.fields.externalId).toBe('"sku"');
      expect(inventory.fields).toMatchObject({
        title: '"title"',
        price: '"price"',
        currency: '"currency"',
      });
      expect(promptMocks.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Which column is the unique listing id?',
          choices: [
            { name: 'sku', value: 'sku' },
            { name: 'title', value: 'title' },
            { name: 'price', value: 'price' },
            { name: 'currency', value: 'currency' },
          ],
        }),
      );
      const idColumnPrompt = promptMocks.select.mock.calls.find(
        (call) =>
          (call[0] as { message?: string } | undefined)?.message ===
          'Which column is the unique listing id?',
      )?.[0] as { default?: string } | undefined;
      expect(idColumnPrompt?.default).toBeUndefined();
    } finally {
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a materialized view with no readable columns before field mapping', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = { destroy: vi.fn().mockResolvedValue(undefined) };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.clearAllMocks();
    promptMocks.select.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Database type')) return Promise.resolve('postgres');
      if (message.startsWith('Which table contains')) return Promise.resolve('inventory');
      throw new Error(`Unexpected select prompt: ${message}`);
    });
    promptMocks.input.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Host')) return Promise.resolve('database.example.com');
      if (message.startsWith('Port')) return Promise.resolve('5432');
      if (message.startsWith('Database name')) return Promise.resolve('catalog');
      if (message.startsWith('PostgreSQL schema')) return Promise.resolve('catalog');
      return Promise.resolve('reader');
    });
    promptMocks.password.mockResolvedValue('p@ss#word');
    promptMocks.confirm.mockResolvedValue(false);
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [{ name: 'inventory', kind: 'materialized view', rowCount: 12000, columns: [] }],
        foreignKeys: [],
      },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await runWizard();

      expect(consoleError).toHaveBeenCalledWith(
        'Cannot save configuration: this materialized view has no readable columns — grant SELECT or pick another object.',
      );
      expect(db.destroy).toHaveBeenCalledOnce();
      expect(promptMocks.select).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Which column contains') }),
      );
    } finally {
      consoleError.mockRestore();
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes deselected inventory mappings when editing an existing configuration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = Object.assign(vi.fn(), {
      destroy: vi.fn().mockResolvedValue(undefined),
      withSchema: vi.fn(() => ({
        table: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
      })),
    });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.clearAllMocks();
    writeFileSync(
      join(directory, 'connector.config.yml'),
      [
        'version: 1',
        'server:',
        '  port: 4100',
        '  host: 0.0.0.0',
        '  trustedProxies: 10.0.0.0/8',
        'auth:',
        '  apiKeys:',
        '    - key: ${CONNECTOR_API_KEY}',
        '      label: kasbly-production',
        'database:',
        '  type: postgres',
        '  host: ${DB_HOST}',
        '  port: 5432',
        '  database: ${DB_NAME}',
        '  user: ${DB_USER}',
        '  password: ${DB_PASSWORD}',
        '  ssl: false',
        'resources:',
        '  inventory:',
        '    schema: merchant_data',
        '    table: products',
        '    baseFilter: "published = true AND deleted_at IS NULL"',
        '    idColumn: id',
        '    fields:',
        '      title: title',
        '      price: price',
        '      currency: currency',
        '      description: description',
        '    attributes:',
        '      make: "makeEn"',
        '      year: year',
        '      legacy_attribute: legacy_attribute',
        '    searchableColumns: [title, description]',
        '    filterableColumns:',
        '      legacy_attribute: { column: legacy_attribute, type: string }',
        '    relations:',
        '      images:',
        '        schema: merchant_data',
        '        table: product_images',
        '        foreignKey: product_id',
        '        referenceKey: id',
        '        fields: { url: url }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(directory, '.env'),
      'DB_HOST=database.example.com\nDB_NAME=catalog\nDB_USER=reader\nDB_PASSWORD=p@ss#word\nCONNECTOR_API_KEY=kc_existing\nCONNECTOR_DOMAIN=connector.merchant.example\n',
    );

    promptMocks.select.mockImplementationOnce(() => Promise.resolve('postgres'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('products'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('id'));
    for (const answer of [
      'title',
      'price',
      'currency',
      '\0unmapped',
      '\0unmapped',
      '\0unmapped',
      '\0unmapped',
    ]) {
      promptMocks.select.mockImplementationOnce(() => Promise.resolve(answer));
    }
    // This rerun replaces Caddy, so it keeps the proxy allowlist it already has.
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('custom'));
    for (const answer of [
      'database.example.com',
      '5432',
      'catalog',
      'reader',
      'merchant_data',
      'connector.merchant.example',
      '10.0.0.0/8',
    ]) {
      promptMocks.input.mockImplementationOnce(() => Promise.resolve(answer));
    }
    promptMocks.confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    promptMocks.checkbox
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [
          {
            name: 'products',
            kind: 'table',
            rowCount: 100,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'title', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'price', type: 'numeric', nullable: false, isPrimaryKey: false },
              { name: 'currency', type: 'varchar', nullable: false, isPrimaryKey: false },
              { name: 'description', type: 'text', nullable: true, isPrimaryKey: false },
              { name: 'published', type: 'boolean', nullable: false, isPrimaryKey: false },
              { name: 'deleted_at', type: 'timestamp', nullable: true, isPrimaryKey: false },
              { name: 'makeEn', type: 'text', nullable: true, isPrimaryKey: false },
              { name: 'year', type: 'integer', nullable: true, isPrimaryKey: false },
              { name: 'legacy_attribute', type: 'text', nullable: true, isPrimaryKey: false },
            ],
          },
          {
            name: 'product_images',
            kind: 'table',
            rowCount: 200,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'product_id', type: 'uuid', nullable: false, isPrimaryKey: false },
              { name: 'url', type: 'text', nullable: false, isPrimaryKey: false },
            ],
          },
        ],
        foreignKeys: [
          {
            fromTable: 'product_images',
            fromColumn: 'product_id',
            toTable: 'products',
            toColumn: 'id',
          },
        ],
      },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await runWizard();

      const generated = yaml.load(
        readFileSync(join(directory, 'connector.config.yml'), 'utf-8'),
      ) as {
        server: { trustedProxies?: string };
        resources: { inventory: Record<string, unknown> };
      };
      const inventory = generated.resources.inventory;
      expect(
        loadExistingSetupConfig(join(directory, 'connector.config.yml'), join(directory, '.env')),
      ).toMatchObject({ resources: { inventory: { fields: { title: '"title"' } } } });
      expect(generated.server.trustedProxies).toBe('10.0.0.0/8');
      // A rerun offers what the operator already deployed with, rather than
      // resetting the connector to the bundled-Caddy defaults.
      expect(promptMocks.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('reverse proxy'),
          default: 'custom',
        }),
      );
      expect(promptMocks.input).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Trusted proxy'),
          default: '10.0.0.0/8',
        }),
      );
      expect(promptMocks.input).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Public DNS name'),
          default: 'connector.merchant.example',
        }),
      );
      expect(parse(readFileSync(join(directory, '.env'), 'utf-8'))['CONNECTOR_DOMAIN']).toBe(
        'connector.merchant.example',
      );
      expect(inventory.fields).toEqual({
        externalId: '"id"',
        title: '"title"',
        price: '"price"',
        currency: '"currency"',
      });
      expect(inventory).not.toHaveProperty('baseFilter');
      expect(inventory).not.toHaveProperty('attributes');
      expect(promptMocks.checkbox).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Select additional columns'),
          choices: expect.arrayContaining([
            expect.objectContaining({ name: 'makeEn', value: 'makeEn', checked: true }),
            expect.objectContaining({ name: 'year', value: 'year', checked: true }),
          ]),
        }),
      );
      expect(inventory).not.toHaveProperty('searchableColumns');
      expect(inventory).not.toHaveProperty('filterableColumns');
      expect(inventory).not.toHaveProperty('relations');
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringContaining('No searchable columns are configured'),
      );
      // Leaving status unmapped makes the whole catalog ACTIVE, and no config key
      // records that choice, so the wizard has to say it out loud.
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'No status column mapped: every listing will be reported as ACTIVE',
        ),
      );
    } finally {
      consoleLog.mockRestore();
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('maps a status column in a non-public schema without an unqualified read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.clearAllMocks();

    // 30 distinct values: more than the wizard will ask about in one session.
    const distinctStatusValues = Array.from(
      { length: 30 },
      (_, index) => `status-${String(index).padStart(2, '0')}`,
    );
    const first = vi.fn().mockResolvedValue(null);
    const table = vi.fn(() => ({ first }));
    const withSchema = vi.fn(() => ({ table }));
    const db = Object.assign(vi.fn(), {
      destroy: vi.fn().mockResolvedValue(undefined),
      raw: vi.fn().mockResolvedValue({
        rows: distinctStatusValues.map((value) => ({ value })),
      }),
      withSchema,
    });

    const statusAnswers = new Map<string, string>([
      ['status-00', 'ACTIVE'],
      ['status-01', '\0unmapped'],
    ]);
    promptMocks.select.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Database type')) return Promise.resolve('postgres');
      if (message.startsWith('Which table contains')) return Promise.resolve('products');
      if (message.startsWith('Which column is the unique listing id')) {
        return Promise.resolve('id');
      }
      if (message.startsWith('How should newly observed')) return Promise.resolve('DRAFT');
      if (message.startsWith('Which reverse proxy')) return Promise.resolve('bundled');
      const statusValueMatch = /^Which Kasbly status matches "(.+)"\?$/.exec(message);
      if (statusValueMatch) {
        return Promise.resolve(statusAnswers.get(statusValueMatch[1]!) ?? 'DRAFT');
      }
      const fieldMatch = /^Which column contains the (\w+)\?$/.exec(message);
      if (fieldMatch && ['title', 'price', 'currency', 'status'].includes(fieldMatch[1]!)) {
        return Promise.resolve(fieldMatch[1]);
      }
      return Promise.resolve('\0unmapped');
    });
    promptMocks.input.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('Host')) return Promise.resolve('database.example.com');
      if (message.startsWith('Port')) return Promise.resolve('5432');
      if (message.startsWith('Database name')) return Promise.resolve('catalog_db');
      if (message.startsWith('PostgreSQL schema')) return Promise.resolve('catalog');
      if (message.startsWith('Public DNS name')) {
        return Promise.resolve('connector.merchant.example');
      }
      return Promise.resolve('reader');
    });
    promptMocks.password.mockResolvedValue('p@ss#word');
    promptMocks.confirm.mockImplementation(({ message }: { message: string }) =>
      Promise.resolve(!message.startsWith('Does this database require TLS')),
    );
    promptMocks.checkbox.mockImplementation(({ message }: { message: string }) =>
      Promise.resolve(message.startsWith('Which columns should be searchable') ? ['title'] : []),
    );
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [
          {
            name: 'products',
            kind: 'table',
            rowCount: 100,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'title', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'price', type: 'numeric', nullable: false, isPrimaryKey: false },
              { name: 'currency', type: 'varchar', nullable: false, isPrimaryKey: false },
              { name: 'status', type: 'varchar', nullable: false, isPrimaryKey: false },
              { name: 'description', type: 'text', nullable: true, isPrimaryKey: false },
            ],
          },
        ],
        foreignKeys: [],
      },
      retriedWithTls: false,
    });

    try {
      process.chdir(directory);
      await runWizard();

      expect(db.raw).toHaveBeenCalledWith(
        expect.stringContaining('SELECT DISTINCT "value" FROM (SELECT ?? AS "value"'),
        [
          'status',
          'catalog',
          'products',
          'status',
          STATUS_VALUE_SCAN_LIMIT,
          STATUS_VALUE_PROMPT_LIMIT,
        ],
      );

      // Setup completes: the config is written, not lost to a thrown error.
      const generated = yaml.load(
        readFileSync(join(directory, 'connector.config.yml'), 'utf-8'),
      ) as { resources: { inventory: Record<string, unknown> } };
      const inventory = generated.resources.inventory;
      expect(inventory['schema']).toBe('catalog');
      expect(inventory['unknownStatusPolicy']).toBe('DRAFT');

      // Bounded prompting: 25 of the 30 values are offered, one of them left unmapped.
      const statusPrompts = promptMocks.select.mock.calls.filter((call: unknown[]) =>
        String((call[0] as { message?: string })?.message ?? '').startsWith(
          'Which Kasbly status matches',
        ),
      );
      expect(statusPrompts).toHaveLength(25);
      const statusValues = inventory['statusValues'] as Record<string, string[]>;
      expect(statusValues['ACTIVE']).toEqual(['status-00']);
      expect(statusValues['DRAFT']).toHaveLength(23);
      expect(statusValues['DRAFT']).not.toContain('status-01');
      expect(statusValues['DRAFT']).not.toContain('status-25');
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringContaining('the remaining 5 use the unknown-status policy'),
      );
    } finally {
      consoleLog.mockRestore();
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
