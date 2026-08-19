import { describe, it, expect } from 'vitest';
import {
  getRelationConfigs,
  getRequiredColumns,
  getSourceStatusValues,
  mapRowToInventoryItem,
  resolveInventoryStatus,
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
