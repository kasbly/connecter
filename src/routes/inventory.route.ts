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
  getMappedImageValues,
  getRelationConfigs,
  getRequiredColumns,
  resolveColumnValue,
  validateInventoryItemWireContract,
  type ConnectorInventoryItem,
} from '../mapping/field-mapper.js';
import type { ResourceHealthCheck } from './health.route.js';

interface InventoryDeps {
  dbAdapter: DatabaseAdapter;
  resourceConfig: InventoryResourceConfig;
  getResourceHealth?: ResourceHealthCheck;
}

function isUncoercibleValueError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code');
  return code === '22P02' || code === '22003';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapValidatedInventoryItem(
  row: Record<string, unknown>,
  resourceConfig: InventoryResourceConfig,
  relationData: Map<string, Map<string, Record<string, unknown>[]>>,
): ConnectorInventoryItem {
  const item = mapRowToInventoryItem(row, resourceConfig, relationData);
  validateInventoryItemWireContract(item, getMappedImageValues(row, resourceConfig, relationData));
  return item;
}

/**
 * Bounded number of additional page fetches `GET /inventory` may issue when
 * wire-contract validation drops rows off the requested page.
 *
 * Combined with a page's own `pageSize`, this absorbs runs of invalid rows up
 * to `MAX_BACKFILL_FETCHES * pageSize` — comfortably past the up-to-19-in-a-row
 * case that could otherwise return zero items to a 5-per-page customer search
 * (#25984) — while still guaranteeing the fetch loop terminates instead of
 * scanning the whole table when a merchant's feed is mostly broken.
 */
const MAX_BACKFILL_FETCHES = 4;

export function registerInventoryRoutes(app: FastifyInstance, deps: InventoryDeps): void {
  const { dbAdapter, resourceConfig, getResourceHealth } = deps;

  // Pre-compute the columns we need — avoids SELECT * on every request
  const selectColumns = getRequiredColumns(resourceConfig);

  const requireReadyInventoryResource = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!getResourceHealth) return;

    try {
      const dbHealthy = await dbAdapter.healthCheck();
      const resourceHealth = dbHealthy ? await getResourceHealth() : undefined;
      if (dbHealthy && resourceHealth?.ok) return;
    } catch {
      // The diagnostic route reports the underlying failure. Inventory requests
      // only need a stable, retryable readiness response.
    }

    await reply.code(503).send({ error: 'Inventory resource is not ready' });
  };

  // GET /inventory — paginated search with filters
  app.get(
    '/inventory',
    { preHandler: requireReadyInventoryResource },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const params = request.query as RawQueryParams;
      const { conditions, pagination, sort, ignoredFilters } = buildQuery(params, resourceConfig);
      const { searchConditions, filterConditions } = splitConditions(conditions);
      const relationConfigs = getRelationConfigs(resourceConfig);

      const runQuery = async (pageOptions: PaginationOptions): Promise<QueryResult> => {
        try {
          return await queryWithSearch(
            dbAdapter,
            resourceConfig,
            searchConditions,
            filterConditions,
            pageOptions,
            sort,
            selectColumns,
          );
        } catch (error) {
          if (!isUncoercibleValueError(error)) throw error;
          // Not necessarily a numeric filter: any filter value PostgreSQL cannot
          // coerce to its column's type lands here, so the message must not send
          // the operator hunting for a number they never sent (#25114).
          throw new QueryValidationError(
            'A filter value is invalid for its configured database column',
          );
        }
      };

      // Fetch relations for and wire-contract-validate one raw batch of rows.
      const validateRows = async (
        rows: Record<string, unknown>[],
      ): Promise<ConnectorInventoryItem[]> => {
        if (rows.length === 0) return [];

        const relationData = new Map<string, Map<string, Record<string, unknown>[]>>();
        if (relationConfigs.length > 0) {
          const relationResults = await Promise.all(
            relationConfigs.map(([relationName, relationConfig]) =>
              dbAdapter
                .queryRelation({
                  ...((relationConfig.schema ?? resourceConfig.schema)
                    ? { schema: relationConfig.schema ?? resourceConfig.schema }
                    : {}),
                  table: relationConfig.table,
                  foreignKey: relationConfig.foreignKey,
                  parentIds: getReferenceValues(rows, relationConfig.referenceKey),
                  fields: relationConfig.fields,
                  filter: relationConfig.filter,
                  orderBy: relationConfig.orderBy,
                })
                .then((result) => [relationName, result] as const),
            ),
          );
          for (const [relationName, result] of relationResults) {
            relationData.set(relationName, result);
          }
        }

        const validated: ConnectorInventoryItem[] = [];
        for (const row of rows) {
          try {
            validated.push(mapValidatedInventoryItem(row, resourceConfig, relationData));
          } catch (error) {
            request.log.warn(
              {
                externalId: String(resolveColumnValue(row, resourceConfig.idColumn) ?? ''),
                error: errorMessage(error),
              },
              'Omitting inventory item that violates the wire contract',
            );
          }
        }
        return validated;
      };

      const first = await runQuery(pagination);
      const { total, totalIsCapped } = first;

      let rowsExamined = first.rows.length;
      let validated = await validateRows(first.rows);
      // A raw batch shorter than what was asked for means the underlying
      // result set ran out — there is nothing left to page in.
      let exhausted = first.rows.length < pagination.pageSize;

      // A short page must mean the result set genuinely ran out, never that
      // the first N rows in sort order happened to fail wire-contract
      // validation (#25984): keep pulling the next page's worth of rows,
      // bounded, until either enough valid rows are collected or the result
      // set is confirmed exhausted.
      for (
        let extraFetch = 0;
        validated.length < pagination.pageSize && !exhausted && extraFetch < MAX_BACKFILL_FETCHES;
        extraFetch++
      ) {
        const backfillPage: PaginationOptions = {
          page: pagination.page + extraFetch + 1,
          pageSize: pagination.pageSize,
        };
        const backfill = await runQuery(backfillPage);
        rowsExamined += backfill.rows.length;
        validated = validated.concat(await validateRows(backfill.rows));
        exhausted = backfill.rows.length < pagination.pageSize;
      }

      const items = validated.slice(0, pagination.pageSize);

      // Rows withheld for a wire-contract violation (#24913) are never served,
      // so they must not be advertised either: callers render `total` as the
      // customer-facing match count ("I found N options") and as the Sources
      // "N listings available" badge. Keeping the raw SQL count promises rows
      // this page — and every later page — will not deliver (#25791). Tallied
      // over every row examined while backfilling this page (#25984), not just
      // the rows the initial fetch happened to return.
      const omittedCount = rowsExamined - validated.length;
      const servableTotal = Math.max(total - omittedCount, items.length);

      const result = {
        items,
        total: servableTotal,
        // `total` is a lower bound whenever the adapter hit its count cap — the
        // exact COUNT(*) is deliberately not run on every request (#17420).
        totalIsCapped: totalIsCapped === true,
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalPages: Math.ceil(servableTotal / pagination.pageSize),
        ...(ignoredFilters.length > 0 ? { ignoredFilters } : {}),
      };

      (request as FastifyRequest & { auditItems?: number }).auditItems = items.length;

      return result;
    },
  );

  // GET /inventory/:id — single item by ID
  app.get(
    '/inventory/:id',
    { preHandler: requireReadyInventoryResource },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      let row: Record<string, unknown> | null;
      try {
        row = resourceConfig.schema
          ? await dbAdapter.queryById(
              resourceConfig.table,
              resourceConfig.idColumn,
              id,
              resourceConfig.baseFilter,
              selectColumns,
              resourceConfig.schema,
            )
          : await dbAdapter.queryById(
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
      const relationData = new Map<string, Map<string, Record<string, unknown>[]>>();

      // Fetch all relations in parallel
      if (relationConfigs.length > 0) {
        const relationResults = await Promise.all(
          relationConfigs.map(([relationName, relationConfig]) =>
            dbAdapter
              .queryRelation({
                ...((relationConfig.schema ?? resourceConfig.schema)
                  ? { schema: relationConfig.schema ?? resourceConfig.schema }
                  : {}),
                table: relationConfig.table,
                foreignKey: relationConfig.foreignKey,
                parentIds: getReferenceValues([row], relationConfig.referenceKey),
                fields: relationConfig.fields,
                filter: relationConfig.filter,
                orderBy: relationConfig.orderBy,
              })
              .then((result) => [relationName, result] as const),
          ),
        );
        for (const [relationName, result] of relationResults) {
          relationData.set(relationName, result);
        }
      }

      try {
        const item = mapValidatedInventoryItem(row, resourceConfig, relationData);
        (request as FastifyRequest & { auditItems?: number }).auditItems = 1;
        return item;
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );
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
  const conditions = [...filterConditions, ...searchConditions];
  return config.schema
    ? dbAdapter.query(
        config.table,
        conditions,
        pagination,
        sort,
        config.baseFilter,
        selectColumns,
        config.schema,
      )
    : dbAdapter.query(config.table, conditions, pagination, sort, config.baseFilter, selectColumns);
}
