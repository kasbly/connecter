import { describe, it, expect } from 'vitest';
import {
  suggestFieldMappings,
  suggestIdColumn,
  suggestUpdatedAtColumn,
  suggestPublishedColumn,
  suggestSoftDeleteColumn,
  suggestRelations,
  suggestSearchableColumns,
  suggestFilterableColumns,
} from '../suggest.js';
import type { IntrospectedColumn, IntrospectedTable, ForeignKeyInfo } from '../introspect.js';

function col(name: string, type = 'text', isPrimaryKey = false): IntrospectedColumn {
  return { name, type, nullable: true, isPrimaryKey };
}

describe('suggestFieldMappings', () => {
  it('maps common column names to standard fields', () => {
    const columns = [
      col('id', 'integer', true),
      col('title', 'text'),
      col('price', 'numeric'),
      col('description', 'text'),
      col('category', 'text'),
    ];

    const suggestions = suggestFieldMappings(columns);
    const mapped = new Map(suggestions.map((s) => [s.suggestedMapping, s.columnName]));

    expect(mapped.get('title')).toBe('title');
    expect(mapped.get('price')).toBe('price');
    expect(mapped.get('description')).toBe('description');
    expect(mapped.get('category')).toBe('category');
  });

  it('maps attribute columns', () => {
    const columns = [
      col('id', 'integer', true),
      col('makeEn', 'text'),
      col('year', 'integer'),
      col('color', 'text'),
      col('kilometers', 'integer'),
      col('transmission', 'text'),
    ];

    const suggestions = suggestFieldMappings(columns);
    const attrs = suggestions.filter((s) => s.mappingType === 'attribute');

    expect(attrs.some((a) => a.suggestedMapping === 'year')).toBe(true);
    expect(attrs.some((a) => a.suggestedMapping === 'color')).toBe(true);
    expect(attrs.some((a) => a.suggestedMapping === 'mileage')).toBe(true);
    expect(attrs.some((a) => a.suggestedMapping === 'transmission')).toBe(true);
  });

  it('skips foreign key and timestamp columns for attributes', () => {
    const columns = [
      col('id', 'integer', true),
      col('tenantId', 'text'),
      col('createdAt', 'timestamp'),
      col('updatedAt', 'timestamp'),
    ];

    const suggestions = suggestFieldMappings(columns);
    const attrNames = suggestions.map((s) => s.columnName);
    expect(attrNames).not.toContain('tenantId');
    expect(attrNames).not.toContain('createdAt');
    expect(attrNames).not.toContain('updatedAt');
  });
});

describe('suggestIdColumn', () => {
  it('prefers primary key', () => {
    const columns = [col('uuid', 'uuid', true), col('id', 'integer')];
    expect(suggestIdColumn(columns)).toBe('uuid');
  });

  it('falls back to id column', () => {
    const columns = [col('id', 'integer'), col('name', 'text')];
    expect(suggestIdColumn(columns)).toBe('id');
  });

  it('returns null when no id-like column', () => {
    const columns = [col('foo', 'text'), col('bar', 'text')];
    expect(suggestIdColumn(columns)).toBeNull();
  });
});

describe('suggestUpdatedAtColumn', () => {
  it('finds updatedAt', () => {
    const columns = [col('id'), col('updatedAt', 'timestamp'), col('createdAt', 'timestamp')];
    expect(suggestUpdatedAtColumn(columns)).toBe('updatedAt');
  });

  it('finds modified_at', () => {
    const columns = [col('id'), col('modified_at', 'timestamp')];
    expect(suggestUpdatedAtColumn(columns)).toBe('modified_at');
  });

  it('returns null when none found', () => {
    const columns = [col('id'), col('name')];
    expect(suggestUpdatedAtColumn(columns)).toBeNull();
  });
});

describe('suggestPublishedColumn', () => {
  it('finds published column', () => {
    expect(suggestPublishedColumn([col('published', 'boolean')])).toBe('published');
    expect(suggestPublishedColumn([col('is_active', 'boolean')])).toBe('is_active');
  });

  it('returns null when none found', () => {
    expect(suggestPublishedColumn([col('name')])).toBeNull();
  });
});

describe('suggestSoftDeleteColumn', () => {
  it('finds deletedAt column', () => {
    expect(suggestSoftDeleteColumn([col('deletedAt', 'timestamp')])).toBe('deletedAt');
    expect(suggestSoftDeleteColumn([col('deleted_at', 'timestamp')])).toBe('deleted_at');
  });
});

describe('suggestRelations', () => {
  it('identifies image tables', () => {
    const tables: IntrospectedTable[] = [
      { name: 'Car', rowCount: 100, columns: [col('id', 'integer', true)] },
      {
        name: 'Image',
        rowCount: 1000,
        columns: [col('id', 'integer', true), col('carId', 'integer'), col('url', 'text')],
      },
    ];
    const fks: ForeignKeyInfo[] = [
      { fromTable: 'Image', fromColumn: 'carId', toTable: 'Car', toColumn: 'id' },
    ];

    const suggestions = suggestRelations('Car', tables, fks);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.relationType).toBe('images');
    expect(suggestions[0]!.confidence).toBe('high');
  });

  it('identifies small feature tables', () => {
    const tables: IntrospectedTable[] = [
      { name: 'Car', rowCount: 100, columns: [col('id', 'integer', true)] },
      {
        name: 'CarFeature',
        rowCount: 500,
        columns: [col('id', 'integer', true), col('carId', 'integer'), col('name', 'text')],
      },
    ];
    const fks: ForeignKeyInfo[] = [
      { fromTable: 'CarFeature', fromColumn: 'carId', toTable: 'Car', toColumn: 'id' },
    ];

    const suggestions = suggestRelations('Car', tables, fks);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.relationType).toBe('features');
  });

  it('returns empty when no foreign keys point to table', () => {
    const tables: IntrospectedTable[] = [
      { name: 'Car', rowCount: 100, columns: [col('id')] },
    ];
    const suggestions = suggestRelations('Car', tables, []);
    expect(suggestions).toEqual([]);
  });
});

describe('suggestSearchableColumns', () => {
  it('suggests text columns matching search patterns', () => {
    const columns = [
      col('id', 'integer', true),
      col('title', 'text'),
      col('makeEn', 'character varying'),
      col('modelEn', 'character varying'),
      col('price', 'numeric'),
      col('year', 'integer'),
    ];

    const suggestions = suggestSearchableColumns(columns);
    const names = suggestions.map((s) => s.columnName);

    expect(names).toContain('title');
    expect(names).toContain('makeEn');
    expect(names).toContain('modelEn');
    expect(names).not.toContain('price');
    expect(names).not.toContain('year');
    expect(names).not.toContain('id');
  });

  it('returns empty for table with no text columns', () => {
    const columns = [
      col('id', 'integer', true),
      col('price', 'numeric'),
      col('year', 'integer'),
    ];
    expect(suggestSearchableColumns(columns)).toEqual([]);
  });

  it('skips primary key text columns', () => {
    const columns = [col('id', 'text', true), col('title', 'text')];
    const names = suggestSearchableColumns(columns).map((s) => s.columnName);
    expect(names).not.toContain('id');
    expect(names).toContain('title');
  });
});

describe('suggestFilterableColumns', () => {
  it('suggests price as gte/lte pair', () => {
    const columns = [
      col('id', 'integer', true),
      col('price', 'numeric'),
    ];
    const fieldMappings = [
      { columnName: 'price', suggestedMapping: 'price', confidence: 'high' as const, mappingType: 'field' as const },
    ];

    const suggestions = suggestFilterableColumns(columns, fieldMappings, []);
    const filterNames = suggestions.map((s) => s.filterName);

    expect(filterNames).toContain('minPrice');
    expect(filterNames).toContain('maxPrice');
    expect(suggestions.find((s) => s.filterName === 'minPrice')!.filterType).toBe('gte');
    expect(suggestions.find((s) => s.filterName === 'maxPrice')!.filterType).toBe('lte');
  });

  it('suggests numeric columns as number filters', () => {
    const columns = [
      col('id', 'integer', true),
      col('year', 'integer'),
    ];
    const fieldMappings = [
      { columnName: 'year', suggestedMapping: 'year', confidence: 'medium' as const, mappingType: 'attribute' as const },
    ];

    const suggestions = suggestFilterableColumns(columns, fieldMappings, []);
    expect(suggestions).toContainEqual(expect.objectContaining({
      filterName: 'year',
      filterType: 'number',
    }));
  });

  it('suggests text attribute columns as string filters', () => {
    const columns = [
      col('id', 'integer', true),
      col('fuelType', 'character varying'),
    ];
    const fieldMappings = [
      { columnName: 'fuelType', suggestedMapping: 'fuelType', confidence: 'medium' as const, mappingType: 'attribute' as const },
    ];

    const suggestions = suggestFilterableColumns(columns, fieldMappings, []);
    expect(suggestions).toContainEqual(expect.objectContaining({
      filterName: 'fuelType',
      filterType: 'string',
    }));
  });

  it('skips free-text columns like title and description', () => {
    const columns = [
      col('id', 'integer', true),
      col('title', 'text'),
      col('description', 'text'),
    ];
    const fieldMappings = [
      { columnName: 'title', suggestedMapping: 'title', confidence: 'high' as const, mappingType: 'field' as const },
      { columnName: 'description', suggestedMapping: 'description', confidence: 'high' as const, mappingType: 'field' as const },
    ];

    const suggestions = suggestFilterableColumns(columns, fieldMappings, []);
    const filterNames = suggestions.map((s) => s.filterName);
    expect(filterNames).not.toContain('title');
    expect(filterNames).not.toContain('description');
  });

  it('includes additional attributes', () => {
    const columns = [
      col('id', 'integer', true),
      col('color', 'character varying'),
    ];

    const suggestions = suggestFilterableColumns(columns, [], ['color']);
    expect(suggestions).toContainEqual(expect.objectContaining({
      filterName: 'color',
      filterType: 'string',
    }));
  });

  it('skips FK and timestamp columns', () => {
    const columns = [
      col('id', 'integer', true),
      col('tenantId', 'text'),
      col('createdAt', 'text'),
    ];

    const suggestions = suggestFilterableColumns(columns, [], []);
    expect(suggestions).toEqual([]);
  });
});
