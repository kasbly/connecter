import type { InventoryResourceConfig } from '../config/config.types.js';
import type { QueryCondition, PaginationOptions, SortOptions } from '../db/adapter.interface.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export interface ParsedQuery {
  conditions: QueryCondition[];
  pagination: PaginationOptions;
  sort: SortOptions;
}

export interface RawQueryParams {
  page?: string;
  pageSize?: string;
  search?: string;
  updatedSince?: string;
  sortBy?: string;
  sortDirection?: string;
  [key: string]: string | undefined;
}

export function buildQuery(
  params: RawQueryParams,
  config: InventoryResourceConfig,
): ParsedQuery {
  const conditions: QueryCondition[] = [];

  // Pagination
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const rawPageSize = parseInt(params.pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);

  // Sort
  const defaultSortColumn = config.updatedAtColumn ?? config.idColumn;
  const sortBy = params.sortBy ?? defaultSortColumn;
  const sortDirection = params.sortDirection === 'asc' ? 'asc' as const : 'desc' as const;

  // Search across searchable columns
  if (params.search && config.searchableColumns && config.searchableColumns.length > 0) {
    for (const col of config.searchableColumns) {
      conditions.push({
        column: col,
        operator: 'ILIKE',
        value: params.search,
      });
    }
  }

  // Updated since filter
  if (params.updatedSince && config.updatedAtColumn) {
    conditions.push({
      column: config.updatedAtColumn,
      operator: '>=',
      value: params.updatedSince,
    });
  }

  // Dynamic filters from filterableColumns config
  if (config.filterableColumns) {
    for (const [filterKey, filterConfig] of Object.entries(config.filterableColumns)) {
      const paramKey = `filter.${filterKey}`;
      const paramValue = params[paramKey];
      if (paramValue === undefined || paramValue === '') continue;

      switch (filterConfig.type) {
        case 'string':
          conditions.push({
            column: filterConfig.column,
            operator: '=',
            value: paramValue,
          });
          break;
        case 'number':
          conditions.push({
            column: filterConfig.column,
            operator: '=',
            value: Number(paramValue),
          });
          break;
        case 'gte':
          conditions.push({
            column: filterConfig.column,
            operator: '>=',
            value: Number(paramValue),
          });
          break;
        case 'lte':
          conditions.push({
            column: filterConfig.column,
            operator: '<=',
            value: Number(paramValue),
          });
          break;
      }
    }
  }

  return {
    conditions,
    pagination: { page, pageSize },
    sort: { column: sortBy, direction: sortDirection },
  };
}

export function isSearchCondition(condition: QueryCondition): boolean {
  return condition.operator === 'ILIKE';
}

/**
 * Splits conditions into search conditions (OR logic) and filter conditions (AND logic).
 * Search conditions use OR among themselves; filter conditions use AND.
 */
export function splitConditions(conditions: QueryCondition[]): {
  searchConditions: QueryCondition[];
  filterConditions: QueryCondition[];
} {
  const searchConditions: QueryCondition[] = [];
  const filterConditions: QueryCondition[] = [];

  for (const c of conditions) {
    if (isSearchCondition(c)) {
      searchConditions.push(c);
    } else {
      filterConditions.push(c);
    }
  }

  return { searchConditions, filterConditions };
}
