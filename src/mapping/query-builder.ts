import type { InventoryResourceConfig } from '../config/config.types.js';
import type { QueryCondition, PaginationOptions, SortOptions } from '../db/adapter.interface.js';
import { isSafeOrderByColumn } from '../db/postgres.adapter.js';
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

function isFixedActiveStatus(config: InventoryResourceConfig): boolean {
  const statusField = config.fields.status;
  return statusField === undefined || /^'ACTIVE'$/i.test(statusField.trim());
}

/**
 * Adds the resource's unique id column as a final sort key.
 *
 * `LIMIT`/`OFFSET` paging over a non-unique sort column (the wizard-preferred
 * `updatedAt`, which a nightly import leaves identical across every row, and
 * which `NULLS LAST` leaves entirely unordered when it is mostly NULL) leaves
 * tied rows in no defined order. Page 1 and page 2 are separate requests and
 * may order that tied block differently, so a listing served on page 1 can
 * reappear on page 2 while another is never returned at all (#24914). The id
 * column is unique, so appending it totally orders the result set.
 *
 * Skipped when the sort column already is the id column — it is unique on its
 * own — and when the configured id column is not a plain column expression the
 * adapter is allowed to interpolate into a raw `ORDER BY` (an id mapped to
 * something like `CAST(id AS text)` still works everywhere else, so it must not
 * start failing requests here).
 */
function withIdTiebreaker(sort: SortOptions, config: InventoryResourceConfig): SortOptions {
  if (normalizeSortColumn(sort.column) === normalizeSortColumn(config.idColumn)) {
    return sort;
  }
  if (!isSafeOrderByColumn(config.idColumn)) {
    return sort;
  }
  return { ...sort, tiebreaker: config.idColumn };
}

/**
 * Default GET /inventory sort: `updatedAt DESC` when configured, otherwise
 * `id DESC`. `/health` and `npm run validate` must sample this same order so
 * they inspect the listing Kasbly's Test connection reads (#23588).
 */
export function getDefaultSort(config: InventoryResourceConfig): SortOptions {
  return withIdTiebreaker(
    {
      column: config.updatedAtColumn ?? config.idColumn,
      direction: 'desc',
    },
    config,
  );
}

export function buildQuery(params: RawQueryParams, config: InventoryResourceConfig): ParsedQuery {
  const conditions: QueryCondition[] = [];
  const pageParam = getSingleQueryValue(params, 'page');
  const pageSizeParam = getSingleQueryValue(params, 'pageSize');
  const search = getSingleQueryValue(params, 'search');
  const updatedSince = getSingleQueryValue(params, 'updatedSince');
  const requestedSortBy = getSingleQueryValue(params, 'sortBy');
  const requestedSortDirection = getSingleQueryValue(params, 'sortDirection');
  const statusFilter = getSingleQueryValue(params, 'filter.status');
  const fixedActiveStatus = isFixedActiveStatus(config);

  const configuredFilterKeys = new Set(Object.keys(config.filterableColumns ?? {}));
  // An unmapped (or literal ACTIVE) status declares that every row is ACTIVE.
  // It therefore enforces ACTIVE without a source column, rather than ignoring
  // the customer-facing filter.
  if (fixedActiveStatus && statusFilter) configuredFilterKeys.add('status');
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

  if (fixedActiveStatus && statusFilter) {
    if (statusFilter !== 'ACTIVE') {
      // A fixed-active catalogue has no rows in any other status. Use a
      // constant false predicate so both the page and total query stay empty.
      conditions.push({ column: '1', operator: '=', value: 0 });
    }
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
          // Kasbly's status vocabulary only reaches the merchant's column
          // through statusValues. A status with no configured source values has
          // no rows, so answer empty with the same constant-false predicate the
          // fixed-ACTIVE branch uses above — comparing the Kasbly token itself
          // against an enum or integer status column aborts the query with
          // SQLSTATE 22P02 instead (#25114).
          conditions.push(
            sourceValues
              ? { column: filterConfig.column, operator: 'IN', value: sourceValues }
              : { column: '1', operator: '=', value: 0 },
          );
          break;
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
    sort: withIdTiebreaker({ column: sortBy, direction: sortDirection }, config),
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
