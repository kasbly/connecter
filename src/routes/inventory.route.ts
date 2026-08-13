import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { InventoryResourceConfig } from '../config/config.types.js';
import type {
  DatabaseAdapter,
  QueryCondition,
  PaginationOptions,
  SortOptions,
  QueryResult,
} from '../db/adapter.interface.js';
import {
  buildQuery,
  QueryValidationError,
  splitConditions,
  type RawQueryParams,
} from '../mapping/query-builder.js';
import {
  mapRowToInventoryItem,
  getRelationConfigs,
  getRequiredColumns,
  resolveColumnValue,
} from '../mapping/field-mapper.js';

interface InventoryDeps {
  dbAdapter: DatabaseAdapter;
  resourceConfig: InventoryResourceConfig;
}

function isUncoercibleValueError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code');
  return code === '22P02' || code === '22003';
}

export function registerInventoryRoutes(app: FastifyInstance, deps: InventoryDeps): void {
  const { dbAdapter, resourceConfig } = deps;

  // Pre-compute the columns we need — avoids SELECT * on every request
  const selectColumns = getRequiredColumns(resourceConfig);

  // GET /inventory — paginated search with filters
  app.get('/inventory', async (request: FastifyRequest, _reply: FastifyReply) => {
    const params = request.query as RawQueryParams;
    const { conditions, pagination, sort } = buildQuery(params, resourceConfig);
    const { searchConditions, filterConditions } = splitConditions(conditions);

    let queryResult: QueryResult;
    try {
      queryResult = await queryWithSearch(
        dbAdapter,
        resourceConfig,
        searchConditions,
        filterConditions,
        pagination,
        sort,
        selectColumns,
      );
    } catch (error) {
      if (!isUncoercibleValueError(error)) throw error;
      throw new QueryValidationError(
        'A numeric filter value is invalid for its configured database column',
      );
    }
    const { rows, total, totalIsCapped } = queryResult;
    // Fetch all relations in parallel
    const relationConfigs = getRelationConfigs(resourceConfig);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();

    if (rows.length > 0 && relationConfigs.length > 0) {
      const relationResults = await Promise.all(
        relationConfigs.map(([relationName, relationConfig]) =>
          dbAdapter
            .queryRelation({
              table: relationConfig.table,
              foreignKey: relationConfig.foreignKey,
              parentIds: getReferenceValues(rows, relationConfig.referenceKey),
              fields: relationConfig.fields,
              filter: relationConfig.filter,
            })
            .then((result) => [relationName, result] as const),
        ),
      );
      for (const [relationName, result] of relationResults) {
        relationData.set(relationName, result);
      }
    }

    const items = rows.map((row) => mapRowToInventoryItem(row, resourceConfig, relationData));

    const result = {
      items,
      total,
      // `total` is a lower bound whenever the adapter hit its count cap — the
      // exact COUNT(*) is deliberately not run on every request (#17420).
      totalIsCapped: totalIsCapped === true,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
    };

    (request as FastifyRequest & { auditItems?: number }).auditItems = items.length;

    return result;
  });

  // GET /inventory/:id — single item by ID
  app.get('/inventory/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    let row: Record<string, unknown> | null;
    try {
      row = await dbAdapter.queryById(
        resourceConfig.table,
        resourceConfig.idColumn,
        id,
        resourceConfig.baseFilter,
        selectColumns,
      );
    } catch (error) {
      // PostgreSQL reports an ID that cannot be coerced to the configured column
      // type as 22P02 (invalid syntax) or 22003 (numeric value out of range). Treat
      // both exactly like a valid but absent ID while preserving the indexed lookup.
      if (!isUncoercibleValueError(error)) throw error;
      row = null;
    }

    if (!row) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    const relationConfigs = getRelationConfigs(resourceConfig);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();

    // Fetch all relations in parallel
    if (relationConfigs.length > 0) {
      const relationResults = await Promise.all(
        relationConfigs.map(([relationName, relationConfig]) =>
          dbAdapter
            .queryRelation({
              table: relationConfig.table,
              foreignKey: relationConfig.foreignKey,
              parentIds: getReferenceValues([row], relationConfig.referenceKey),
              fields: relationConfig.fields,
              filter: relationConfig.filter,
            })
            .then((result) => [relationName, result] as const),
        ),
      );
      for (const [relationName, result] of relationResults) {
        relationData.set(relationName, result);
      }
    }

    const item = mapRowToInventoryItem(row, resourceConfig, relationData);

    (request as FastifyRequest & { auditItems?: number }).auditItems = 1;

    return item;
  });
}

function getReferenceValues(
  rows: Record<string, unknown>[],
  referenceKey: string,
): (string | number)[] {
  return rows
    .map((row) => resolveColumnValue(row, referenceKey))
    .filter((value): value is string | number => {
      return typeof value === 'string' || typeof value === 'number';
    });
}

async function queryWithSearch(
  dbAdapter: DatabaseAdapter,
  config: InventoryResourceConfig,
  searchConditions: QueryCondition[],
  filterConditions: QueryCondition[],
  pagination: PaginationOptions,
  sort: SortOptions,
  selectColumns: string[],
): Promise<QueryResult> {
  return dbAdapter.query(
    config.table,
    [...filterConditions, ...searchConditions],
    pagination,
    sort,
    config.baseFilter,
    selectColumns,
  );
}
