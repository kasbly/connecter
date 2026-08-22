import { describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIELD_MAPPING_TARGETS,
  backupPrivateFile,
  getFieldMappingPrompt,
  loadExistingSetupConfig,
  mergeEnvironmentFile,
  quoteIfNeeded,
  serializeEnvValue,
  shouldDefaultToTls,
  toConfigLiteral,
  writePrivateFile,
} from '../wizard.js';
import { runWizard } from '../wizard.js';
import { buildQuery } from '../../mapping/query-builder.js';
import { introspectDatabase } from '../introspect.js';

const promptMocks = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

const introspectionMocks = vi.hoisted(() => ({ introspectDatabase: vi.fn() }));

vi.mock('@inquirer/prompts', () => promptMocks);
vi.mock('../introspect.js', () => introspectionMocks);

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
  it('writes a loadable config whose quoted fields support bare sortBy values', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const previousDirectory = process.cwd();
    const db = Object.assign(vi.fn(), { destroy: vi.fn().mockResolvedValue(undefined) });

    promptMocks.select.mockImplementationOnce(() => Promise.resolve('postgres'));
    promptMocks.select.mockImplementationOnce(() => Promise.resolve('products'));
    for (const answer of [
      'title',
      'price',
      'currency',
      '\0unmapped',
      '\0unmapped',
      'description',
    ]) {
      promptMocks.select.mockImplementationOnce(() => Promise.resolve(answer));
    }
    for (const answer of ['database.example.com', '5432', 'catalog', 'reader']) {
      promptMocks.input.mockImplementationOnce(() => Promise.resolve(answer));
    }
    promptMocks.password.mockResolvedValueOnce('p@ss#word');
    promptMocks.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    promptMocks.checkbox
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['title', 'description'])
      .mockResolvedValueOnce(['minPrice', 'maxPrice', 'currency'])
      .mockResolvedValueOnce(['url']);
    vi.mocked(introspectDatabase).mockResolvedValueOnce({
      db: db as never,
      result: {
        tables: [
          {
            name: 'products',
            rowCount: 100,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'title', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'price', type: 'numeric', nullable: false, isPrimaryKey: false },
              { name: 'currency', type: 'varchar', nullable: false, isPrimaryKey: false },
              { name: 'description', type: 'text', nullable: true, isPrimaryKey: false },
            ],
          },
          {
            name: 'product_images',
            rowCount: 200,
            columns: [
              { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
              { name: 'product_id', type: 'uuid', nullable: false, isPrimaryKey: false },
              { name: 'url', type: 'text', nullable: false, isPrimaryKey: false },
              { name: 'sort_order', type: 'integer', nullable: false, isPrimaryKey: false },
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

      const config = loadExistingSetupConfig(
        join(directory, 'connector.config.yml'),
        join(directory, '.env'),
      );
      expect(config.resources.inventory.fields.price).toBe('"price"');
      expect(buildQuery({ sortBy: 'price' }, config.resources.inventory).sort.column).toBe(
        config.resources.inventory.fields.price,
      );
    } finally {
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
