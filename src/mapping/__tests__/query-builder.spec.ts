import { describe, it, expect } from 'vitest';
import { buildQuery, splitConditions } from '../query-builder.js';
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
  },
};

describe('buildQuery', () => {
  it('returns default pagination and sort', () => {
    const result = buildQuery({}, baseConfig);
    expect(result.pagination).toEqual({ page: 1, pageSize: 20 });
    expect(result.sort).toEqual({ column: 'updatedAt', direction: 'desc' });
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

  it('generates search conditions', () => {
    const result = buildQuery({ search: 'Hyundai' }, baseConfig);
    const { searchConditions } = splitConditions(result.conditions);
    expect(searchConditions).toHaveLength(2);
    expect(searchConditions[0]!.operator).toBe('ILIKE');
    expect(searchConditions[0]!.value).toBe('Hyundai');
  });

  it('generates filter conditions for string type', () => {
    const result = buildQuery({ 'filter.make': 'Toyota' }, baseConfig);
    expect(result.conditions).toContainEqual({
      column: '"makeEn"',
      operator: '=',
      value: 'Toyota',
    });
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
    const result = buildQuery({ 'filter.minPrice': '10000', 'filter.maxPrice': '50000' }, baseConfig);
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

  it('generates updatedSince condition', () => {
    const result = buildQuery({ updatedSince: '2026-01-01T00:00:00Z' }, baseConfig);
    expect(result.conditions).toContainEqual({
      column: 'updatedAt',
      operator: '>=',
      value: '2026-01-01T00:00:00Z',
    });
  });

  it('uses custom sort', () => {
    const result = buildQuery({ sortBy: 'price', sortDirection: 'asc' }, baseConfig);
    expect(result.sort).toEqual({ column: 'price', direction: 'asc' });
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
