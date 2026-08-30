import type { InventoryResourceConfig } from '../config/config.types.js';
import type { QueryCondition, PaginationOptions, SortOptions } from '../db/adapter.interface.js';
import { getRequiredColumns, getSourceStatusValues } from './field-mapper.js';

const MAX_PAGE_SIZE = 100;
const MAX_PAGE_OFFSET = 100_000;
/** Default number of listings returned by GET /inventory. */
export const DEFAULT_PAGE_SIZE = 20;
const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TERMS = 10;

export interface ParsedQuery {
  conditions: QueryCondition[];
  pagination: PaginationOptions;
  sort: SortOptions;
  /** Filter names supplied by the caller that this connector cannot apply. */
  ignoredFilters: string[];
}

export interface RawQueryParams {
  page?: string | string[];
  pageSize?: string | string[];
  search?: string | string[];
  updatedSince?: string | string[];
  sortBy?: string | string[];
  sortDirection?: string | string[];
  [key: string]: string | string[] | undefined;
}

export class QueryValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'QueryValidationError';
  }
}

function getSingleQueryValue(params: RawQueryParams, key: string): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) {
    throw new QueryValidationError(`Query parameter "${key}" must be provided only once`);
  }
  return value;
}

function parseNumericFilter(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new QueryValidationError(`Query parameter "${key}" must be a finite number`);
  }
  return parsed;
}

function normalizeSortColumn(columnExpr: string): string {
  const trimmedColumnExpr = columnExpr.trim();
  const quotedColumnMatch = /^"(.+)"$/.exec(trimmedColumnExpr);
  return quotedColumnMatch ? quotedColumnMatch[1]! : trimmedColumnExpr;
}

/**
 * Default GET /inventory sort: `updatedAt DESC` when configured, otherwise
 * `id DESC`. `/health` and `npm run validate` must sample this same order so
 * they inspect the listing Kasbly's Test connection reads (#23588).
 */
export function getDefaultSort(config: InventoryResourceConfig): SortOptions {
  return {
    column: config.updatedAtColumn ?? config.idColumn,
    direction: 'desc',
  };
}

export function buildQuery(params: RawQueryParams, config: InventoryResourceConfig): ParsedQuery {
  const conditions: QueryCondition[] = [];
  const pageParam = getSingleQueryValue(params, 'page');
  const pageSizeParam = getSingleQueryValue(params, 'pageSize');
  const search = getSingleQueryValue(params, 'search');
  const updatedSince = getSingleQueryValue(params, 'updatedSince');
  const requestedSortBy = getSingleQueryValue(params, 'sortBy');
  const requestedSortDirection = getSingleQueryValue(params, 'sortDirection');

  const configuredFilterKeys = new Set(Object.keys(config.filterableColumns ?? {}));
  const ignoredFilters = Object.keys(params)
    .filter(
      (key) => key.startsWith('filter.') && !configuredFilterKeys.has(key.slice('filter.'.length)),
    )
    .map((key) => key.slice('filter.'.length));

  // A free-text search without configured columns used to be silently omitted,
  // which made a caller mistake an unfiltered catalog page for search results.
  // Keep this capability signal in the existing response contract used for
  // unsupported configured filters.
  if (search?.trim() && (config.searchableColumns?.length ?? 0) === 0) {
    ignoredFilters.push('search');
  }

  if (search && search.length > MAX_SEARCH_LENGTH) {
    throw new QueryValidationError(
      `Query parameter "search" must not exceed ${MAX_SEARCH_LENGTH} characters`,
    );
  }

  // Pagination
  const page = Math.max(1, parseInt(pageParam ?? '1', 10) || 1);
  const rawPageSize = parseInt(pageSizeParam ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  if (offset > MAX_PAGE_OFFSET) {
    throw new QueryValidationError(
      `Query parameter "page" must not exceed an offset of ${MAX_PAGE_OFFSET} rows`,
    );
  }

  // Sort — sortBy is client-controlled (query string) and ends up interpolated into a raw
  // ORDER BY clause in postgres.adapter.ts, so it must never be trusted as-is (#14461).
  // Restrict it to columns the resource config actually knows about — reusing
  // getRequiredColumns() (the same set already used to build the SELECT clause) as the
  // allowlist, rather than maintaining a second list that could drift from the config.
  // Anything else — including SQL injection payloads — silently falls back to the default
  // sort column instead of ever reaching raw SQL.
  const defaultSort = getDefaultSort(config);
  const allowedSortColumns = new Map(
    getRequiredColumns(config).map((column) => [normalizeSortColumn(column), column]),
  );
  const sortBy =
    requestedSortBy !== undefined
      ? (allowedSortColumns.get(normalizeSortColumn(requestedSortBy)) ?? defaultSort.column)
      : defaultSort.column;
  const sortDirection = requestedSortDirection === 'asc' ? ('asc' as const) : defaultSort.direction;

  // Search across searchable columns
  // Split search into individual terms — each term must match at least one searchable column (AND between terms, OR between columns per term)
  if (search && config.searchableColumns && config.searchableColumns.length > 0) {
    const searchTerms = search
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, MAX_SEARCH_TERMS);

    for (const term of searchTerms) {
      for (const col of config.searchableColumns) {
        conditions.push({
          column: col,
          operator: 'ILIKE',
          value: term,
          _group: term,
        });
      }
    }
  }

  // Updated since filter
  if (updatedSince && Number.isNaN(Date.parse(updatedSince))) {
    throw new QueryValidationError(
      'Query parameter "updatedSince" must be a valid date or timestamp',
    );
  }
  if (updatedSince && config.updatedAtColumn) {
    conditions.push({
      column: config.updatedAtColumn,
      operator: '>=',
      value: new Date(updatedSince).toISOString(),
    });
  }

  // Dynamic filters from filterableColumns config. Unknown keys are reported
  // in the response instead of making an otherwise valid inventory request fail.
  for (const [filterKey, filterConfig] of Object.entries(config.filterableColumns ?? {})) {
    const paramKey = `filter.${filterKey}`;
    const paramValue = getSingleQueryValue(params, paramKey);
    if (paramValue === undefined || paramValue === '') continue;

    switch (filterConfig.type) {
      case 'string':
        if (filterKey === 'status') {
          const sourceValues = getSourceStatusValues(paramValue, config.statusValues);
          if (sourceValues) {
            conditions.push({ column: filterConfig.column, operator: 'IN', value: sourceValues });
            break;
          }
        }
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
          value: parseNumericFilter(paramValue, paramKey),
        });
        break;
      case 'gte':
        conditions.push({
          column: filterConfig.column,
          operator: '>=',
          value: parseNumericFilter(paramValue, paramKey),
        });
        break;
      case 'lte':
        conditions.push({
          column: filterConfig.column,
          operator: '<=',
          value: parseNumericFilter(paramValue, paramKey),
        });
        break;
    }
  }

  return {
    conditions,
    pagination: { page, pageSize },
    sort: { column: sortBy, direction: sortDirection },
    ignoredFilters,
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
