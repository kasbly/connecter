import { describe, expect, it } from 'vitest';
import { connectorConfigSchema } from '../config.schema.js';

function createConfigInput(databaseOverrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    auth: {
      apiKeys: [{ key: 'test-key', label: 'test' }],
    },
    database: {
      type: 'postgres',
      host: 'database.internal',
      database: 'inventory',
      user: 'connector',
      password: 'password',
      ...databaseOverrides,
    },
    resources: {
      inventory: {
        table: 'cars',
        idColumn: 'id',
        fields: { externalId: 'id', title: 'title', price: 'price', currency: "'SAR'" },
      },
    },
  };
}

describe('connectorConfigSchema database TLS options', () => {
  it('defaults certificate verification to enabled', () => {
    const config = connectorConfigSchema.parse(createConfigInput({ ssl: true }));

    expect(config.database.sslRejectUnauthorized).toBe(true);
    expect(config.database.sslCa).toBeUndefined();
  });

  it('accepts a pinned CA bundle and an explicit verification escape hatch', () => {
    const sslCa = '-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----';
    const config = connectorConfigSchema.parse(
      createConfigInput({
        ssl: true,
        sslCa,
        sslRejectUnauthorized: false,
      }),
    );

    expect(config.database).toMatchObject({
      ssl: true,
      sslCa,
      sslRejectUnauthorized: false,
    });
  });

  it('rejects an empty CA bundle', () => {
    expect(() =>
      connectorConfigSchema.parse(createConfigInput({ ssl: true, sslCa: '' })),
    ).toThrow();
  });
});

describe('connectorConfigSchema inventory fields', () => {
  it('defaults schemas to public and keeps schemas separate from table names', () => {
    const config = connectorConfigSchema.parse({
      ...createConfigInput(),
      resources: {
        inventory: {
          ...createConfigInput().resources.inventory,
          schema: 'catalog',
          relations: {
            images: {
              schema: 'media',
              table: 'images',
              foreignKey: 'product_id',
              referenceKey: 'id',
              fields: { url: 'url' },
            },
          },
        },
      },
    });

    expect(config.resources.inventory.schema).toBe('catalog');
    expect(config.resources.inventory.relations?.images?.schema).toBe('media');
    expect(connectorConfigSchema.parse(createConfigInput()).resources.inventory.schema).toBe(
      'public',
    );
  });

  it.each(['catalog.products', 'catalog-products', '1catalog'])(
    'rejects an unsafe PostgreSQL schema identifier: %s',
    (schema) => {
      expect(() =>
        connectorConfigSchema.parse({
          ...createConfigInput(),
          resources: { inventory: { ...createConfigInput().resources.inventory, schema } },
        }),
      ).toThrow();
    },
  );

  it.each(['title', 'price', 'currency'])('requires a %s mapping', (field) => {
    const config = createConfigInput();
    const fields = config.resources.inventory.fields as Record<string, string>;
    delete fields[field];

    expect(() => connectorConfigSchema.parse(config)).toThrow();
  });

  it('accepts an optional relation orderBy', () => {
    const config = connectorConfigSchema.parse({
      ...createConfigInput(),
      resources: {
        inventory: {
          ...createConfigInput().resources.inventory,
          relations: {
            images: {
              table: 'images',
              foreignKey: 'product_id',
              referenceKey: 'id',
              fields: { url: 'url' },
              orderBy: { column: 'position', direction: 'asc' },
            },
          },
        },
      },
    });

    expect(config.resources.inventory.relations?.images?.orderBy).toEqual({
      column: 'position',
      direction: 'asc',
    });
  });

  it('defaults and accepts source values for the closed inventory status vocabulary', () => {
    const defaults = connectorConfigSchema.parse(createConfigInput());
    expect(defaults.resources.inventory.statusValues.SOLD).toEqual(['SOLD', 'sold']);
    expect(defaults.resources.inventory.unknownStatusPolicy).toBe('DRAFT');

    const configured = connectorConfigSchema.parse({
      ...createConfigInput(),
      resources: {
        inventory: {
          ...createConfigInput().resources.inventory,
          statusValues: { ACTIVE: ['for_sale'], SOLD: ['sold_out'] },
        },
      },
    });
    // A partially mapped block must not inherit Kasbly's English word list for
    // the keys the merchant left out: those words reach the merchant's status
    // column as comparison values (#25114).
    expect(configured.resources.inventory.statusValues).toEqual({
      ACTIVE: ['for_sale'],
      SOLD: ['sold_out'],
    });
  });

  it.each(['ACTIVE', 'unknown'])('rejects an unsafe unknown-status policy: %s', (policy) => {
    expect(() =>
      connectorConfigSchema.parse({
        ...createConfigInput(),
        resources: {
          inventory: { ...createConfigInput().resources.inventory, unknownStatusPolicy: policy },
        },
      }),
    ).toThrow();
  });
});

describe('connectorConfigSchema database statement timeout', () => {
  it('defaults queries to a bounded ten-second timeout', () => {
    const config = connectorConfigSchema.parse(createConfigInput());

    expect(config.database.statementTimeoutMs).toBe(10_000);
  });

  it('accepts a configured timeout within the safety bounds', () => {
    const config = connectorConfigSchema.parse(createConfigInput({ statementTimeoutMs: 2_500 }));

    expect(config.database.statementTimeoutMs).toBe(2_500);
  });

  it.each([0, 99, 120_001])('rejects an unsafe timeout of %dms', (statementTimeoutMs) => {
    expect(() => connectorConfigSchema.parse(createConfigInput({ statementTimeoutMs }))).toThrow();
  });
});

describe('connectorConfigSchema audit file size', () => {
  it('defaults the number of retained rotated audit files to ten', () => {
    expect(connectorConfigSchema.parse(createConfigInput()).audit.maxFiles).toBe(10);
  });

  it('accepts a configured number of retained rotated audit files', () => {
    expect(
      connectorConfigSchema.parse({ ...createConfigInput(), audit: { maxFiles: 25 } }).audit
        .maxFiles,
    ).toBe(25);
  });

  it.each([0, 1.5])('rejects an invalid number of rotated audit files: %d', (maxFiles) => {
    expect(() =>
      connectorConfigSchema.parse({ ...createConfigInput(), audit: { maxFiles } }),
    ).toThrow();
  });

  it('rejects audit rotation thresholds above the safety cap', () => {
    expect(() =>
      connectorConfigSchema.parse({ ...createConfigInput(), audit: { maxFileSizeMB: 501 } }),
    ).toThrow();
  });
});

// Issue #15729 — trustedProxies gates whether forwarded headers (X-Forwarded-For,
// X-Real-IP) are honored for rate-limiting and audit-log IP attribution.
describe('connectorConfigSchema server.trustedProxies', () => {
  it('defaults to unset (forwarded headers are never trusted)', () => {
    const config = connectorConfigSchema.parse(createConfigInput());

    expect(config.server.trustedProxies).toBeUndefined();
  });

  it('accepts a comma-separated IP/CIDR allowlist', () => {
    const config = connectorConfigSchema.parse({
      ...createConfigInput(),
      server: { trustedProxies: '10.0.0.0/8,203.0.113.5' },
    });

    expect(config.server.trustedProxies).toBe('10.0.0.0/8,203.0.113.5');
  });

  it('rejects an empty trustedProxies string', () => {
    expect(() =>
      connectorConfigSchema.parse({
        ...createConfigInput(),
        server: { trustedProxies: '' },
      }),
    ).toThrow();
  });
});
