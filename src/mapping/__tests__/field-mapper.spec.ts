import { describe, it, expect } from 'vitest';
import { mapRowToInventoryItem, getRelationConfigs, getRequiredColumns } from '../field-mapper.js';
import type { InventoryResourceConfig } from '../../config/config.types.js';

const baseConfig: InventoryResourceConfig = {
  table: 'Car',
  idColumn: 'id',
  updatedAtColumn: 'updatedAt',
  fields: {
    externalId: 'id',
    title: 'title',
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
      price: 15000000,
      makeEn: 'Hyundai',
      year: 2024,
      updatedAt: new Date('2026-01-15T10:00:00Z'),
    };

    const result = mapRowToInventoryItem(row, baseConfig, new Map());

    expect(result.externalId).toBe('123');
    expect(result.title).toBe('2024 Hyundai Sonata');
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

  it('handles missing updatedAt', () => {
    const configNoUpdate = { ...baseConfig, updatedAtColumn: undefined };
    const row = { id: '1', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, configNoUpdate, new Map());
    expect(result.updatedAt).toBeNull();
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
    imageData.set('123', [
      { url: 'http://img1.jpg' },
      { url: 'http://img2.jpg' },
    ]);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();
    relationData.set('images', imageData);

    const row = { id: '123', title: 'Test', price: 100 };
    const result = mapRowToInventoryItem(row, configWithRelations, relationData);
    expect(result.images).toEqual(['http://img1.jpg', 'http://img2.jpg']);
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
});
