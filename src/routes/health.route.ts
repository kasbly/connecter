import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { InventoryResourceConfig } from '../config/config.types.js';
import type { DatabaseAdapter } from '../db/adapter.interface.js';
import {
  getRelationConfigs,
  getRequiredColumns,
  resolveColumnValue,
} from '../mapping/field-mapper.js';

let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    cachedVersion = pkg.version;
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

const startTime = Date.now();
const RESOURCE_PROBE_TTL_MS = 30_000;

interface ResourceHealth {
  ok: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Runs the smallest read-only query that exercises the configured inventory
 * mapping. It is shared by startup validation and `/health` so a ready
 * connector has proved it can read its merchant's inventory resource.
 */
export async function probeInventoryResource(
  dbAdapter: DatabaseAdapter,
  resourceConfig: InventoryResourceConfig,
): Promise<void> {
  // Search and configured filters do not need to be selected for a normal
  // inventory response, but they are column expressions the resource can use.
  // Include them in the probe so startup catches those latent mapping errors.
  const selectColumns = Array.from(
    new Set([
      ...getRequiredColumns(resourceConfig),
      ...(resourceConfig.searchableColumns ?? []),
      ...Object.values(resourceConfig.filterableColumns ?? {}).map(({ column }) => column),
    ]),
  );
  let rows: Record<string, unknown>[];

  try {
    ({ rows } = await dbAdapter.query(
      resourceConfig.table,
      [],
      { page: 1, pageSize: 1 },
      { column: resourceConfig.idColumn, direction: 'asc' },
      resourceConfig.baseFilter,
      selectColumns,
    ));
  } catch (error) {
    throw new Error(
      `Inventory resource probe failed for table "${resourceConfig.table}" ` +
        `(columns: ${selectColumns.join(', ')}): ${errorMessage(error)}`,
    );
  }

  await Promise.all(
    getRelationConfigs(resourceConfig).map(async ([relationName, relationConfig]) => {
      try {
        await dbAdapter.queryRelation({
          table: relationConfig.table,
          foreignKey: relationConfig.foreignKey,
          parentIds: getReferenceValues(rows, relationConfig.referenceKey),
          fields: relationConfig.fields,
          filter: relationConfig.filter,
        });
      } catch (error) {
        throw new Error(
          `Inventory relation "${relationName}" probe failed for table ` +
            `"${relationConfig.table}": ${errorMessage(error)}`,
        );
      }
    }),
  );
}

export function registerHealthRoute(
  app: FastifyInstance,
  dbAdapter: DatabaseAdapter,
  resourceConfig: InventoryResourceConfig,
): void {
  let cachedResourceHealth: ResourceHealth | undefined;
  let cachedResourceHealthAt = 0;
  let resourceProbeInFlight: Promise<ResourceHealth> | undefined;

  const getResourceHealth = async (): Promise<ResourceHealth> => {
    if (cachedResourceHealth && Date.now() - cachedResourceHealthAt < RESOURCE_PROBE_TTL_MS) {
      return cachedResourceHealth;
    }

    if (!resourceProbeInFlight) {
      resourceProbeInFlight = probeInventoryResource(dbAdapter, resourceConfig)
        .then(() => ({ ok: true }))
        .catch((error: unknown) => ({ ok: false, error: errorMessage(error) }))
        .then((health) => {
          cachedResourceHealth = health;
          cachedResourceHealthAt = Date.now();
          return health;
        })
        .finally(() => {
          resourceProbeInFlight = undefined;
        });
    }

    return resourceProbeInFlight;
  };

  app.get('/health', async (_request, reply) => {
    const [dbHealthy, resourceHealth] = await Promise.all([
      dbAdapter.healthCheck(),
      getResourceHealth(),
    ]);
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (!dbHealthy || !resourceHealth.ok) reply.code(503);

    return {
      status: dbHealthy && resourceHealth.ok ? 'ok' : 'degraded',
      version: getVersion(),
      database: dbHealthy ? 'connected' : 'disconnected',
      resources: resourceHealth.ok ? 'ok' : 'misconfigured',
      ...(resourceHealth.error ? { resourceError: resourceHealth.error } : {}),
      uptime: uptimeSeconds,
    };
  });
}
