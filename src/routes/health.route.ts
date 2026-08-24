import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AuditHealth } from '../audit/audit.service.js';
import type { InventoryResourceConfig } from '../config/config.types.js';
import type { DatabaseAdapter } from '../db/adapter.interface.js';
import {
  getRelationConfigs,
  getRequiredColumns,
  resolveColumnValue,
  resolveInventoryStatus,
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

export interface ResourceHealth {
  ok: boolean;
  error?: string;
  /** Source statuses seen by the probe that need an explicit mapping. */
  unknownStatusValues?: string[];
}

export type ResourceHealthCheck = () => Promise<ResourceHealth>;
export type AuditHealthCheck = () => AuditHealth;

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
): Promise<string[]> {
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
    ({ rows } = resourceConfig.schema
      ? await dbAdapter.query(
          resourceConfig.table,
          [],
          { page: 1, pageSize: 1 },
          { column: resourceConfig.idColumn, direction: 'asc' },
          resourceConfig.baseFilter,
          selectColumns,
          resourceConfig.schema,
        )
      : await dbAdapter.query(
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
          ...((relationConfig.schema ?? resourceConfig.schema)
            ? { schema: relationConfig.schema ?? resourceConfig.schema }
            : {}),
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

  const statusColumn = resourceConfig.fields['status'];
  if (!statusColumn) return [];

  return Array.from(
    new Set(
      rows.flatMap((row) => {
        const value = resolveColumnValue(row, statusColumn);
        const normalizedValue = value === null || value === undefined ? '' : String(value).trim();
        return normalizedValue && !resolveInventoryStatus(value, resourceConfig.statusValues)
          ? [normalizedValue]
          : [];
      }),
    ),
  ).sort();
}

export function createResourceHealthCheck(
  dbAdapter: DatabaseAdapter,
  resourceConfig: InventoryResourceConfig,
): ResourceHealthCheck {
  let cachedResourceHealth: ResourceHealth | undefined;
  let cachedResourceHealthAt = 0;
  let resourceProbeInFlight: Promise<ResourceHealth> | undefined;

  return async (): Promise<ResourceHealth> => {
    if (cachedResourceHealth && Date.now() - cachedResourceHealthAt < RESOURCE_PROBE_TTL_MS) {
      return cachedResourceHealth;
    }

    if (!resourceProbeInFlight) {
      resourceProbeInFlight = probeInventoryResource(dbAdapter, resourceConfig)
        .then((unknownStatusValues) => ({
          ok: true,
          ...(unknownStatusValues.length > 0 ? { unknownStatusValues } : {}),
        }))
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
}

export function registerHealthRoute(
  app: FastifyInstance,
  dbAdapter: DatabaseAdapter,
  getResourceHealth: ResourceHealthCheck,
  getAuditHealth: AuditHealthCheck = () => ({ enabled: false, ok: true }),
): void {
  app.get('/health', async (_request, reply) => {
    const dbHealthy = await dbAdapter.healthCheck().catch(() => false);
    const resourceHealth = dbHealthy ? await getResourceHealth() : undefined;
    const auditHealth = getAuditHealth();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (!dbHealthy || !resourceHealth?.ok || !auditHealth.ok) reply.code(503);

    return {
      status: dbHealthy && resourceHealth?.ok && auditHealth.ok ? 'ok' : 'degraded',
      version: getVersion(),
      database: dbHealthy ? 'connected' : 'disconnected',
      resources: resourceHealth ? (resourceHealth.ok ? 'ok' : 'misconfigured') : 'unavailable',
      audit: auditHealth.enabled ? (auditHealth.ok ? 'ok' : 'degraded') : 'disabled',
      ...(resourceHealth?.error ? { resourceError: resourceHealth.error } : {}),
      ...(auditHealth.error ? { auditError: auditHealth.error } : {}),
      ...(auditHealth.lastSuccessfulAppendAt
        ? { auditLastSuccessfulAppendAt: auditHealth.lastSuccessfulAppendAt }
        : {}),
      ...(resourceHealth?.unknownStatusValues?.length
        ? { unknownStatusValues: resourceHealth.unknownStatusValues }
        : {}),
      uptime: uptimeSeconds,
    };
  });
}
