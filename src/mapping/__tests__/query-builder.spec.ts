import { describe, it, expect } from 'vitest';
import { buildQuery, getDefaultSort, splitConditions } from '../query-builder.js';
import type { InventoryResourceConfig } from '../../config/config.types.js';

const baseConfig: InventoryResourceConfig = {
  table: 'Car',
  idColumn: 'id',
  updatedAtColumn: 'updatedAt',
  fields: { title: 'title', price: 'price' },
  searchableColumns: ['title', '"makeEn"'],
  filterableColumns: {
    year: { column: 'year', type: 'number' },
    make: { column: '"makeEn"', type: 'string' },
    minPrice: { column: 'price', type: 'gte' },
    maxPrice: { column: 'price', type: 'lte' },
    minYear: { column: 'year', type: 'gte' },
    maxYear: { column: 'year', type: 'lte' },
  },
};

describe('getDefaultSort', () => {
  it('uses updatedAt DESC when configured', () => {
    expect(getDefaultSort(baseConfig)).toEqual({
      column: 'updatedAt',
      direction: 'desc',
      tiebreaker: 'id',
    });
  });

  it('uses id DESC when updatedAt is not configured', () => {
    // No tiebreaker: the id column is already the sort column, and unique.
    expect(getDefaultSort({ ...baseConfig, updatedAtColumn: undefined })).toEqual({
      column: 'id',
      direction: 'desc',
    });
  });

  it('omits the tiebreaker when the id column is quoted but still the sort column', () => {
    expect(getDefaultSort({ ...baseConfig, idColumn: '"id"', updatedAtColumn: undefined })).toEqual(
      { column: '"id"', direction: 'desc' },
    );
  });

  it('omits the tiebreaker when the id column is not a plain column expression', () => {
    // An id mapped to an expression works for SELECT and lookup-by-id, so it
    // must not start failing the raw ORDER BY guard on every list request.
    expect(getDefaultSort({ ...baseConfig, idColumn: 'CAST(id AS text)' })).toEqual({
      column: 'updatedAt',
      direction: 'desc',
    });
  });
});

describe('buildQuery', () => {
  it('returns default pagination and sort', () => {
    const result = buildQuery({}, baseConfig);
    expect(result.pagination).toEqual({ page: 1, pageSize: 20 });
    expect(result.sort).toEqual({ column: 'updatedAt', direction: 'desc', tiebreaker: 'id' });
    expect(result.sort).toEqual(getDefaultSort(baseConfig));
    expect(result.conditions).toEqual([]);
  });

  it('parses page and pageSize', () => {
    const result = buildQuery({ page: '3', pageSize: '50' }, baseConfig);
    expect(result.pagination).toEqual({ page: 3, pageSize: 50 });
  });

  it('caps pageSize at 100', () => {
    const result = buildQuery({ pageSize: '200' }, baseConfig);
    expect(result.pagination.pageSize).toBe(100);
  });

  it('floors page at 1', () => {
    const result = buildQuery({ page: '-5' }, baseConfig);
    expect(result.pagination.page).toBe(1);
  });

  it('allows a page whose offset is exactly 100,000 rows', () => {
    const result = buildQuery({ page: '1001', pageSize: '100' }, baseConfig);
    expect(result.pagination).toEqual({ page: 1001, pageSize: 100 });
  });

  it.each([{ page: '1002', pageSize: '100' }, { page: '9999999999999999999' }])(
    'rejects pagination beyond the maximum row offset: %j',
    (params) => {
      expect(() => buildQuery(params, baseConfig)).toThrow(
        expect.objectContaining({
          statusCode: 400,
          message: 'Query parameter "page" must not exceed an offset of 100000 rows',
        }),
      );
    },
  );

  it('generates search conditions', () => {
    const result = buildQuery({ search: 'Hyundai' }, baseConfig);
    const { searchConditions } = splitConditions(result.conditions);
    expect(searchConditions).toHaveLength(2);
    expect(searchConditions[0]!.operator).toBe('ILIKE');
    expect(searchConditions[0]!.value).toBe('Hyundai');
  });

  it('reports a non-empty search when no searchable columns are configured', () => {
    const result = buildQuery(
      { search: 'iPhone' },
      { ...baseConfig, searchableColumns: undefined },
    );

    expect(result.conditions).toEqual([]);
    expect(result.ignoredFilters).toEqual(['search']);
  });

  it('rejects search values longer than 200 characters', () => {
    expect(() => buildQuery({ search: 'a'.repeat(201) }, baseConfig)).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'Query parameter "search" must not exceed 200 characters',
      }),
    );
  });

  it('limits search expansion to the first 10 terms', () => {
    const result = buildQuery(
      { search: Array.from({ length: 11 }, (_, index) => `term${index + 1}`).join(' ') },
      baseConfig,
    );
    const { searchConditions } = splitConditions(result.conditions);

    expect(searchConditions).toHaveLength(20);
    expect(searchConditions.some((condition) => condition.value === 'term10')).toBe(true);
    expect(searchConditions.some((condition) => condition.value === 'term11')).toBe(false);
  });

  it('rejects repeated scalar query parameters', () => {
    expect(() => buildQuery({ search: ['Hyundai', 'Toyota'] }, baseConfig)).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'Query parameter "search" must be provided only once',
      }),
    );
  });

  it('generates filter conditions for string type', () => {
    const result = buildQuery({ 'filter.make': 'Toyota' }, baseConfig);
    expect(result.conditions).toContainEqual({
      column: '"makeEn"',
      operator: '=',
      value: 'Toyota',
    });
  });

  it('translates Kasbly status filters to the configured source values', () => {
    const result = buildQuery(
      { 'filter.status': 'SOLD' },
      {
        ...baseConfig,
        filterableColumns: {
          ...baseConfig.filterableColumns,
          status: { column: 'availability', type: 'string' },
        },
        statusValues: { SOLD: ['sold', 'closed'] },
      },
    );

    expect(result.conditions).toContainEqual({
      column: 'availability',
      operator: 'IN',
      value: ['sold', 'closed'],
    });
  });

  it('enforces ACTIVE without ignoring it when every listing is implicitly active', () => {
    const result = buildQuery(
      { 'filter.status': 'ACTIVE' },
      { ...baseConfig, fields: { title: 'title', price: 'price' } },
    );

    expect(result.conditions).toEqual([]);
    expect(result.ignoredFilters).not.toContain('status');
  });

  it('returns no rows for a non-ACTIVE filter on an implicitly active catalogue', () => {
    const result = buildQuery(
      { 'filter.status': 'SOLD' },
      { ...baseConfig, fields: { title: 'title', price: 'price' } },
    );

    expect(result.conditions).toContainEqual({ column: '1', operator: '=', value: 0 });
    expect(result.ignoredFilters).not.toContain('status');
  });

  it('treats a literal ACTIVE status mapping as an enforced fixed status', () => {
    const result = buildQuery(
      { 'filter.status': 'ACTIVE' },
      { ...baseConfig, fields: { ...baseConfig.fields, status: "'ACTIVE'" } },
    );

    expect(result.conditions).toEqual([]);
    expect(result.ignoredFilters).not.toContain('status');
  });

  it('generates filter conditions for number type', () => {
    const result = buildQuery({ 'filter.year': '2024' }, baseConfig);
    expect(result.conditions).toContainEqual({
      column: 'year',
      operator: '=',
      value: 2024,
    });
  });

  it('generates gte/lte conditions', () => {
    const result = buildQuery(
      { 'filter.minPrice': '10000', 'filter.maxPrice': '50000' },
      baseConfig,
    );
    expect(result.conditions).toContainEqual({
      column: 'price',
      operator: '>=',
      value: 10000,
    });
    expect(result.conditions).toContainEqual({
      column: 'price',
      operator: '<=',
      value: 50000,
    });
  });

  it('generates year range conditions', () => {
    const result = buildQuery({ 'filter.minYear': '2020', 'filter.maxYear': '2022' }, baseConfig);
    expect(result.conditions).toContainEqual({ column: 'year', operator: '>=', value: 2020 });
    expect(result.conditions).toContainEqual({ column: 'year', operator: '<=', value: 2022 });
  });

  it('reports filter parameters that are not declared in the config without rejecting the query', () => {
    const result = buildQuery(
      { 'filter.minMileage': '10000', 'filter.color': 'blue', 'filter.make': 'Toyota' },
      baseConfig,
    );

    expect(result.ignoredFilters).toEqual(['minMileage', 'color']);
    expect(result.conditions).toContainEqual({
      column: '"makeEn"',
      operator: '=',
      value: 'Toyota',
    });
  });

  it.each(['filter.year', 'filter.minPrice', 'filter.maxPrice'])(
    'rejects a non-numeric %s value before it reaches the database',
    (paramKey) => {
      expect(() => buildQuery({ [paramKey]: 'not-a-number' }, baseConfig)).toThrow(
        expect.objectContaining({
          statusCode: 400,
          message: `Query parameter "${paramKey}" must be a finite number`,
        }),
      );
    },
  );

  it.each([
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    ['2020', '2020-01-01T00:00:00.000Z'],
    ['Sat Aug 01 2026 10:00:00 GMT+0300 (Arabia Standard Time)', '2026-08-01T07:00:00.000Z'],
  ])('normalizes updatedSince %j before building the condition', (updatedSince, expected) => {
    const result = buildQuery({ updatedSince }, baseConfig);
    expect(result.conditions).toContainEqual({
      column: 'updatedAt',
      operator: '>=',
      value: expected,
    });
  });

  it('rejects an invalid updatedSince value before it reaches the database', () => {
    expect(() => buildQuery({ updatedSince: 'not-a-date' }, baseConfig)).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'Query parameter "updatedSince" must be a valid date or timestamp',
      }),
    );
  });

  it('uses custom sort', () => {
    const result = buildQuery({ sortBy: 'price', sortDirection: 'asc' }, baseConfig);
    expect(result.sort).toEqual({ column: 'price', direction: 'asc', tiebreaker: 'id' });
  });

  describe('sortBy allowlisting (#14461)', () => {
    it('accepts a sortBy matching a configured field column', () => {
      const result = buildQuery({ sortBy: 'title' }, baseConfig);
      expect(result.sort).toEqual({ column: 'title', direction: 'desc', tiebreaker: 'id' });
    });

    it('accepts a sortBy matching the id column', () => {
      const result = buildQuery({ sortBy: 'id' }, baseConfig);
      // Already unique — no second sort key is added on top of it (#24914).
      expect(result.sort).toEqual({ column: 'id', direction: 'desc' });
    });

    it('accepts a sortBy matching a configured attribute column', () => {
      const configWithAttributes: InventoryResourceConfig = {
        ...baseConfig,
        attributes: { make: '"makeEn"' },
      };
      const result = buildQuery({ sortBy: '"makeEn"' }, configWithAttributes);
      expect(result.sort).toEqual({ column: '"makeEn"', direction: 'desc', tiebreaker: 'id' });
    });

    it('accepts a bare sortBy for a quoted configured column', () => {
      const wizardGeneratedConfig: InventoryResourceConfig = {
        ...baseConfig,
        idColumn: '"id"',
        updatedAtColumn: '"updatedAt"',
        fields: { title: '"title"', price: '"price"' },
      };

      const result = buildQuery({ sortBy: 'price', sortDirection: 'asc' }, wizardGeneratedConfig);

      expect(result.sort).toEqual({ column: '"price"', direction: 'asc', tiebreaker: '"id"' });
    });

    it('falls back to the default sort column when sortBy is not a known column', () => {
      const result = buildQuery({ sortBy: 'nonexistentColumn' }, baseConfig);
      expect(result.sort).toEqual({ column: 'updatedAt', direction: 'desc', tiebreaker: 'id' });
    });

    it('falls back to the default sort column when sortBy is empty', () => {
      const result = buildQuery({ sortBy: '' }, baseConfig);
      expect(result.sort).toEqual({ column: 'updatedAt', direction: 'desc', tiebreaker: 'id' });
    });

    it.each([
      '(CASE WHEN (SELECT 1)=1 THEN price ELSE 1/0 END)',
      'price; DROP TABLE "Car"; --',
      'price, (SELECT pg_sleep(5))',
      '(SELECT pg_sleep(5))',
      "price' OR '1'='1",
      'price/**/OR/**/1=1',
      'price ASC; SELECT pg_sleep(5)',
    ])(
      'falls back to the default sort column instead of forwarding the SQL injection payload %j',
      (payload) => {
        const result = buildQuery({ sortBy: payload }, baseConfig);
        expect(result.sort).toEqual({ column: 'updatedAt', direction: 'desc', tiebreaker: 'id' });
      },
    );

    it('falls back to the idColumn when there is no updatedAtColumn and sortBy is malicious', () => {
      const configNoUpdatedAt: InventoryResourceConfig = {
        ...baseConfig,
        updatedAtColumn: undefined,
      };
      const result = buildQuery({ sortBy: '(SELECT pg_sleep(5))' }, configNoUpdatedAt);
      expect(result.sort).toEqual({ column: 'id', direction: 'desc' });
    });
  });
});

describe('splitConditions', () => {
  it('separates ILIKE from other conditions', () => {
    const conditions = [
      { column: 'title', operator: 'ILIKE' as const, value: 'test' },
      { column: 'year', operator: '=' as const, value: 2024 },
    ];
    const { searchConditions, filterConditions } = splitConditions(conditions);
    expect(searchConditions).toHaveLength(1);
    expect(filterConditions).toHaveLength(1);
  });
});
