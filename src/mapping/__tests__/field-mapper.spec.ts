import { describe, it, expect } from 'vitest';
import {
  getRelationConfigs,
  getRequiredColumns,
  getSourceStatusValues,
  mapRowToInventoryItem,
  normalizeImageUrls,
  resolveInventoryStatus,
  validateInventoryItemWireContract,
} from '../field-mapper.js';
import type { InventoryResourceConfig } from '../../config/config.types.js';

const baseConfig: InventoryResourceConfig = {
  table: 'Car',
  idColumn: 'id',
  updatedAtColumn: 'updatedAt',
  fields: {
    externalId: 'id',
    title: 'title',
    description: 'description',
    price: 'price',
    currency: "'KRW'",
    category: "'car'",
  },
  attributes: {
    makeEn: '"makeEn"',
    year: 'year',
  },
};

describe('mapRowToInventoryItem', () => {
  it('maps a basic row with fixed fields and attributes', () => {
    const row = {
      id: '123',
      title: '2024 Hyundai Sonata',
      description: 'Comfortable, low-mileage sedan',
      price: 15000000,
      makeEn: 'Hyundai',
      year: 2024,
      updatedAt: new Date('2026-01-15T10:00:00Z'),
    };

    const result = mapRowToInventoryItem(row, baseConfig, new Map());

    expect(result.externalId).toBe('123');
    expect(result.title).toBe('2024 Hyundai Sonata');
    expect(result.description).toBe('Comfortable, low-mileage sedan');
    expect(result.price).toBe(15000000);
    expect(result.currency).toBe('KRW');
    expect(result.category).toBe('car');
    expect(result.attributes.makeEn).toBe('Hyundai');
    expect(result.attributes.year).toBe(2024);
    expect(result.updatedAt).toBe('2026-01-15T10:00:00.000Z');
  });

  it('handles literal string values in config', () => {
    const row = { id: '1', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, baseConfig, new Map());
    expect(result.currency).toBe('KRW');
    expect(result.category).toBe('car');
  });

  it('handles quoted column names', () => {
    const row = { id: '1', title: 'Test', price: 100, makeEn: 'Toyota', year: 2023 };
    const result = mapRowToInventoryItem(row, baseConfig, new Map());
    expect(result.attributes.makeEn).toBe('Toyota');
  });

  it('unwraps quoted ID and updated-at columns when reading database row keys', () => {
    const config = {
      ...baseConfig,
      idColumn: '"externalId"',
      updatedAtColumn: '"updatedAt"',
    };
    const row = {
      externalId: 'quoted-123',
      title: 'Test',
      price: 100,
      updatedAt: new Date('2026-03-01T12:00:00Z'),
    };

    const result = mapRowToInventoryItem(row, config, new Map());

    expect(result.externalId).toBe('quoted-123');
    expect(result.updatedAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('handles missing updatedAt', () => {
    const configNoUpdate = { ...baseConfig, updatedAtColumn: undefined };
    const row = { id: '1', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, configNoUpdate, new Map());
    expect(result.updatedAt).toBeNull();
  });

  it('returns null when no description field is configured', () => {
    const { description: _description, ...fields } = baseConfig.fields;
    const result = mapRowToInventoryItem(
      { id: '1', title: 'Test', price: 100 },
      { ...baseConfig, fields },
      new Map(),
    );

    expect(result.description).toBeNull();
  });

  it('does not coerce a NULL or missing price to 0', () => {
    const nullPrice = mapRowToInventoryItem(
      { id: '1', title: 'Test', price: null },
      baseConfig,
      new Map(),
    );
    const missingPrice = mapRowToInventoryItem({ id: '1', title: 'Test' }, baseConfig, new Map());

    expect(nullPrice.price).not.toBe(0);
    expect(Number.isFinite(nullPrice.price)).toBe(false);
    expect(missingPrice.price).not.toBe(0);
    expect(Number.isFinite(missingPrice.price)).toBe(false);
    expect(() => validateInventoryItemWireContract(nullPrice)).toThrow(/price/);
    expect(() => validateInventoryItemWireContract(missingPrice)).toThrow(/price/);
  });

  it('rejects locale-formatted PostgreSQL money values as invalid prices', () => {
    const result = mapRowToInventoryItem(
      { id: '1', title: 'Test', price: '$1,234.56' },
      baseConfig,
      new Map(),
    );

    expect(Number.isFinite(result.price)).toBe(false);
    expect(() => validateInventoryItemWireContract(result)).toThrow(/price/);
  });

  it('keeps an explicit 0 price as a finite 0', () => {
    const result = mapRowToInventoryItem(
      { id: '1', title: 'Test', price: 0 },
      baseConfig,
      new Map(),
    );

    expect(result.price).toBe(0);
    expect(() => validateInventoryItemWireContract(result)).not.toThrow();
  });

  it('keeps mapping when the configured currency column is null for a row', () => {
    const config = {
      ...baseConfig,
      fields: { ...baseConfig.fields, currency: 'currency' },
    };

    const result = mapRowToInventoryItem(
      { id: '1', title: 'Test', price: 100, currency: null },
      config,
      new Map(),
    );

    expect(result.currency).toBe('');
  });

  it('rejects object-valued title and currency fields instead of stringifying them', () => {
    const config = {
      ...baseConfig,
      fields: { ...baseConfig.fields, currency: 'currency' },
    };
    const result = mapRowToInventoryItem(
      {
        id: '1',
        title: { en: '2024 Hyundai Sonata', ar: 'هيونداي سوناتا 2024' },
        price: 100,
        currency: { code: 'SAR' },
      },
      config,
      new Map(),
    );

    expect(result.title).toBe('');
    expect(result.currency).toBe('');
    expect(() => validateInventoryItemWireContract(result)).toThrow(/title.*currency/);
  });

  it('maps configured source statuses to Kasbly status tokens', () => {
    const config: InventoryResourceConfig = {
      ...baseConfig,
      fields: { ...baseConfig.fields, status: 'availability' },
      statusValues: { ACTIVE: ['for_sale'], SOLD: ['sold_out'] },
    };

    expect(
      mapRowToInventoryItem(
        { id: '1', title: 'Test', price: 100, availability: 'sold_out' },
        config,
        new Map(),
      ).status,
    ).toBe('SOLD');
    expect(
      mapRowToInventoryItem(
        { id: '2', title: 'Test', price: 100, availability: 'for_sale' },
        config,
        new Map(),
      ).status,
    ).toBe('ACTIVE');
  });

  it('reports every listing as ACTIVE when fields.status is not mapped at all', () => {
    // baseConfig has no `status` key: the configuration the README and
    // connector.config.example.yml tell merchants to use when their whole
    // catalog is live. An absent mapping is that assertion, not source drift.
    expect(baseConfig.fields['status']).toBeUndefined();
    expect(
      mapRowToInventoryItem({ id: '1', title: 'Test', price: 100 }, baseConfig, new Map()).status,
    ).toBe('ACTIVE');

    // The row may still carry a status column the config never mapped, and the
    // unknown-status policy governs mapped columns only — neither may pull an
    // unmapped catalog back to a non-sellable token.
    expect(
      mapRowToInventoryItem(
        { id: '2', title: 'Test', price: 100, status: 'draft' },
        { ...baseConfig, unknownStatusPolicy: 'EXPIRED' },
        new Map(),
      ).status,
    ).toBe('ACTIVE');
  });

  it('uses a non-sellable fallback for new source statuses until they are mapped', () => {
    const config: InventoryResourceConfig = {
      ...baseConfig,
      fields: { ...baseConfig.fields, status: 'availability' },
      statusValues: { ACTIVE: ['for_sale'], SOLD: ['sold_out'] },
      unknownStatusPolicy: 'EXPIRED',
    };

    expect(
      mapRowToInventoryItem(
        { id: '1', title: 'Test', price: 100, availability: 'discontinued' },
        config,
        new Map(),
      ).status,
    ).toBe('EXPIRED');
    expect(
      mapRowToInventoryItem(
        { id: '2', title: 'Test', price: 100, availability: 'backorder' },
        { ...config, unknownStatusPolicy: undefined },
        new Map(),
      ).status,
    ).toBe('DRAFT');
    // A mapped column that is NULL on a row is drift too, not the "everything is
    // active" declaration an entirely absent mapping makes.
    expect(
      mapRowToInventoryItem(
        { id: '3', title: 'Test', price: 100, availability: null },
        config,
        new Map(),
      ).status,
    ).toBe('EXPIRED');
  });

  it('uses the documented case-insensitive defaults for canonical status values', () => {
    expect(resolveInventoryStatus('sold', undefined)).toBe('SOLD');
    expect(getSourceStatusValues('SOLD', undefined)).toEqual(['SOLD', 'sold']);
  });

  it('processes image relations', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        images: {
          table: 'Image',
          foreignKey: '"carId"',
          referenceKey: 'id',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
      },
    };

    const imageData = new Map<string | number, Record<string, unknown>[]>();
    imageData.set('123', [{ url: 'http://img1.jpg' }, { url: 'http://img2.jpg' }]);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();
    relationData.set('images', imageData);

    const row = { id: '123', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, configWithRelations, relationData);
    expect(result.images).toEqual(['http://img1.jpg', 'http://img2.jpg']);
  });

  it('merges images from every named image relation', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        product_images: {
          table: 'ProductImage',
          foreignKey: 'productId',
          referenceKey: 'id',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
        variant_images: {
          table: 'VariantImage',
          foreignKey: 'productId',
          referenceKey: 'id',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
      },
    };
    const relationData = new Map([
      ['product_images', new Map([['123', [{ url: 'http://product.jpg' }]]])],
      ['variant_images', new Map([['123', [{ url: 'http://variant.jpg' }]]])],
    ]);

    const result = mapRowToInventoryItem(
      { id: '123', title: 'Test', price: 100 },
      configWithRelations,
      relationData,
    );

    expect(result.images).toEqual(['http://product.jpg', 'http://variant.jpg']);
  });

  it('normalizes a single URL, PostgreSQL array, and JSON array from the inventory row', () => {
    expect(normalizeImageUrls(' https://example.com/primary.jpg ')).toEqual([
      'https://example.com/primary.jpg',
    ]);
    expect(
      normalizeImageUrls(['https://example.com/one.jpg', '', 'https://example.com/two.jpg']),
    ).toEqual(['https://example.com/one.jpg', 'https://example.com/two.jpg']);
    expect(
      normalizeImageUrls('["https://example.com/one.jpg", "https://example.com/two.jpg"]'),
    ).toEqual(['https://example.com/one.jpg', 'https://example.com/two.jpg']);
  });

  it('places inventory-row images before related-table images', () => {
    const config: InventoryResourceConfig = {
      ...baseConfig,
      fields: { ...baseConfig.fields, images: 'image_urls' },
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'carId',
          referenceKey: 'id',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
      },
    };
    const relationData = new Map([
      ['images', new Map([['123', [{ url: 'https://example.com/relation.jpg' }]]])],
    ]);

    const result = mapRowToInventoryItem(
      {
        id: '123',
        title: 'Test',
        price: 100,
        image_urls: '["https://example.com/primary.jpg"]',
      },
      config,
      relationData,
    );

    expect(result.images).toEqual([
      'https://example.com/primary.jpg',
      'https://example.com/relation.jpg',
    ]);
  });

  it('groups relation rows by the configured parent reference key', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'carSlug',
          referenceKey: '"slug"',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
      },
    };
    const imageData = new Map<string | number, Record<string, unknown>[]>([
      ['sonata-2024', [{ url: 'http://img.jpg' }]],
    ]);
    const relationData = new Map([['images', imageData]]);

    const result = mapRowToInventoryItem(
      { id: '123', slug: 'sonata-2024', title: 'Test', price: 100 },
      configWithRelations,
      relationData,
    );

    expect(result.images).toEqual(['http://img.jpg']);
  });

  it('processes flatten relations', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        features: {
          table: 'CarFeatures',
          foreignKey: '"carId"',
          referenceKey: 'id',
          fields: { name: '"featureName"' },
          flatten: 'name',
        },
      },
    };

    const featureData = new Map<string | number, Record<string, unknown>[]>();
    featureData.set('123', [{ name: 'ABS' }, { name: 'Airbag' }]);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();
    relationData.set('features', featureData);

    const row = { id: '123', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, configWithRelations, relationData);
    expect(result.attributes.features).toEqual(['ABS', 'Airbag']);
  });
});

describe('validateInventoryItemWireContract', () => {
  it('reports the mapped price field when JSON serialization turns NaN into null', () => {
    expect(() =>
      validateInventoryItemWireContract({
        externalId: 'sku-1',
        title: 'Coffee',
        description: null,
        price: Number.NaN,
        currency: 'SAR',
        category: '',
        status: 'ACTIVE',
        images: [],
        attributes: {},
        updatedAt: null,
      }),
    ).toThrow(/price/);
  });

  it('reports missing identifiers, titles, currencies, and invalid dates by field', () => {
    expect(() =>
      validateInventoryItemWireContract({
        externalId: '',
        title: '',
        description: null,
        price: 1,
        currency: '',
        category: '',
        status: 'ACTIVE',
        images: [],
        attributes: {},
        updatedAt: 'not-a-date',
      }),
    ).toThrow(/externalId.*title.*currency.*updatedAt/);
  });

  it('reports malformed image values even when mapping would otherwise discard them', () => {
    expect(() =>
      validateInventoryItemWireContract(
        {
          externalId: 'sku-1',
          title: 'Coffee',
          description: null,
          price: 1,
          currency: 'SAR',
          category: '',
          status: 'ACTIVE',
          images: [],
          attributes: {},
          updatedAt: null,
        },
        ['["https://example.com/coffee.jpg", 42]'],
      ),
    ).toThrow(/images\[1\]/);
  });
});

describe('getRelationConfigs', () => {
  it('returns empty array when no relations', () => {
    expect(getRelationConfigs(baseConfig)).toEqual([]);
  });

  it('returns relation entries', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'carId',
          referenceKey: 'id',
          fields: { url: 'url' },
        },
      },
    };
    const result = getRelationConfigs(configWithRelations);
    expect(result).toHaveLength(1);
    expect(result[0]![0]).toBe('images');
  });
});

describe('getRequiredColumns', () => {
  it('extracts columns from fields, attributes, id, and updatedAt', () => {
    const cols = getRequiredColumns(baseConfig);
    expect(cols).toContain('id');
    expect(cols).toContain('updatedAt');
    expect(cols).toContain('title');
    expect(cols).toContain('price');
    expect(cols).toContain('"makeEn"');
    expect(cols).toContain('year');
  });

  it('skips literal values', () => {
    const cols = getRequiredColumns(baseConfig);
    // "'KRW'" and "'car'" are literals, should not appear
    expect(cols).not.toContain("'KRW'");
    expect(cols).not.toContain("'car'");
  });

  it('includes parent columns referenced by relations', () => {
    const configWithRelations: InventoryResourceConfig = {
      ...baseConfig,
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'carSlug',
          referenceKey: '"slug"',
          fields: { url: 'url' },
        },
      },
    };

    expect(getRequiredColumns(configWithRelations)).toContain('"slug"');
  });
});
