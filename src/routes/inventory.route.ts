import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { InventoryResourceConfig } from '../config/config.types.js';
import type { DatabaseAdapter, QueryCondition, PaginationOptions, SortOptions, QueryResult } from '../db/adapter.interface.js';
import { buildQuery, splitConditions, type RawQueryParams } from '../mapping/query-builder.js';
import { mapRowToInventoryItem, getRelationConfigs, getRequiredColumns } from '../mapping/field-mapper.js';
import type { AuditService } from '../audit/audit.service.js';

interface InventoryDeps {
  dbAdapter: DatabaseAdapter;
  resourceConfig: InventoryResourceConfig;
  auditService: AuditService;
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  deps: InventoryDeps,
): void {
  const { dbAdapter, resourceConfig, auditService } = deps;

  // Pre-compute the columns we need — avoids SELECT * on every request
  const selectColumns = getRequiredColumns(resourceConfig);

  // GET /inventory — paginated search with filters
  app.get('/inventory', async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const params = request.query as RawQueryParams;
    const { conditions, pagination, sort } = buildQuery(params, resourceConfig);
    const { searchConditions, filterConditions } = splitConditions(conditions);

    const { rows, total } = await queryWithSearch(
      dbAdapter,
      resourceConfig,
      searchConditions,
      filterConditions,
      pagination,
      sort,
      selectColumns,
    );
    // Fetch all relations in parallel
    const relationConfigs = getRelationConfigs(resourceConfig);
    const parentIds = rows.map((r) => r[resourceConfig.idColumn] as string | number);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();

    if (parentIds.length > 0 && relationConfigs.length > 0) {
      const relationResults = await Promise.all(
        relationConfigs.map(([relationName, relationConfig]) =>
          dbAdapter.queryRelation({
            table: relationConfig.table,
            foreignKey: relationConfig.foreignKey,
            parentIds,
            fields: relationConfig.fields,
            filter: relationConfig.filter,
          }).then((result) => [relationName, result] as const),
        ),
      );
      for (const [relationName, result] of relationResults) {
        relationData.set(relationName, result);
      }
    }

    const items = rows.map((row) =>
      mapRowToInventoryItem(row, resourceConfig, relationData),
    );

    const result = {
      items,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
    };

    const elapsed = Date.now() - startMs;
    const apiKeyLabel = (request as FastifyRequest & { apiKeyLabel?: string }).apiKeyLabel ?? 'unknown';
    auditService.log({
      ts: new Date().toISOString(),
      method: 'GET',
      path: '/inventory',
      query: params as Record<string, unknown>,
      apiKey: apiKeyLabel,
      status: 200,
      items: items.length,
      ms: elapsed,
      ip: request.ip,
    });

    return result;
  });

  // GET /inventory/:id — single item by ID
  app.get('/inventory/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const { id } = request.params as { id: string };

    const row = await dbAdapter.queryById(
      resourceConfig.table,
      resourceConfig.idColumn,
      id,
      resourceConfig.baseFilter,
      selectColumns,
    );

    if (!row) {
      const elapsed = Date.now() - startMs;
      const apiKeyLabel = (request as FastifyRequest & { apiKeyLabel?: string }).apiKeyLabel ?? 'unknown';
      auditService.log({
        ts: new Date().toISOString(),
        method: 'GET',
        path: `/inventory/${id}`,
        query: {},
        apiKey: apiKeyLabel,
        status: 404,
        items: 0,
        ms: elapsed,
        ip: request.ip,
      });
      return reply.code(404).send({ error: 'Item not found' });
    }

    const parentId = row[resourceConfig.idColumn] as string | number;
    const relationConfigs = getRelationConfigs(resourceConfig);
    const relationData = new Map<string, Map<string | number, Record<string, unknown>[]>>();

    // Fetch all relations in parallel
    if (relationConfigs.length > 0) {
      const relationResults = await Promise.all(
        relationConfigs.map(([relationName, relationConfig]) =>
          dbAdapter.queryRelation({
            table: relationConfig.table,
            foreignKey: relationConfig.foreignKey,
            parentIds: [parentId],
            fields: relationConfig.fields,
            filter: relationConfig.filter,
          }).then((result) => [relationName, result] as const),
        ),
      );
      for (const [relationName, result] of relationResults) {
        relationData.set(relationName, result);
      }
    }

    const item = mapRowToInventoryItem(row, resourceConfig, relationData);

    const elapsed = Date.now() - startMs;
    const apiKeyLabel = (request as FastifyRequest & { apiKeyLabel?: string }).apiKeyLabel ?? 'unknown';
    auditService.log({
      ts: new Date().toISOString(),
      method: 'GET',
      path: `/inventory/${id}`,
      query: {},
      apiKey: apiKeyLabel,
      status: 200,
      items: 1,
      ms: elapsed,
      ip: request.ip,
    });

    return item;
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
