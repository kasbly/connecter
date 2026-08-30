import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AuditHealth } from '../audit/audit.service.js';
import type { InventoryResourceConfig, UnknownStatusPolicy } from '../config/config.types.js';
import type { DatabaseAdapter } from '../db/adapter.interface.js';
import {
  getMappedImageValues,
  getRelationConfigs,
  getRequiredColumns,
  mapRowToInventoryItem,
  resolveColumnValue,
  resolveInventoryStatus,
  validateInventoryItemWireContract,
} from '../mapping/field-mapper.js';
import { DEFAULT_PAGE_SIZE, getDefaultSort } from '../mapping/query-builder.js';

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

/** Most distinct source status values one probe reports (#23293). */
export const UNKNOWN_STATUS_VALUE_LIMIT = 50;

/**
 * Most rows the distinct-status probe may read. The probe runs behind the
 * unauthenticated, 30s-cached `/health` endpoint, so it stays a bounded sample
 * rather than a full scan of the merchant's production table — but a sample
 * this wide answers "which source values are unmapped" independently of row
 * order, which reading the single mapped sample row never could.
 */
export const UNKNOWN_STATUS_SCAN_LIMIT = 5_000;

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
 * Runs a bounded read-only query that exercises the configured inventory
 * mapping. It is shared by startup validation and `/health` so a ready
 * connector has proved it can read a normal inventory page from the merchant.
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
  // Same default sort as GET /inventory so /health and Kasbly Test connection
  // inspect the same listing (#23588).
  const sampleSort = getDefaultSort(resourceConfig);

  try {
    ({ rows } = resourceConfig.schema
      ? await dbAdapter.query(
          resourceConfig.table,
          [],
          { page: 1, pageSize: DEFAULT_PAGE_SIZE },
          sampleSort,
          resourceConfig.baseFilter,
          selectColumns,
          resourceConfig.schema,
        )
      : await dbAdapter.query(
          resourceConfig.table,
          [],
          { page: 1, pageSize: DEFAULT_PAGE_SIZE },
          sampleSort,
          resourceConfig.baseFilter,
          selectColumns,
        ));
  } catch (error) {
    throw new Error(
      `Inventory resource probe failed for table "${resourceConfig.table}" ` +
        `(columns: ${selectColumns.join(', ')}): ${errorMessage(error)}`,
    );
  }

  const relationEntries = await Promise.all(
    getRelationConfigs(resourceConfig).map(async ([relationName, relationConfig]) => {
      try {
        const relationRows = await dbAdapter.queryRelation({
          ...((relationConfig.schema ?? resourceConfig.schema)
            ? { schema: relationConfig.schema ?? resourceConfig.schema }
            : {}),
          table: relationConfig.table,
          foreignKey: relationConfig.foreignKey,
          parentIds: getReferenceValues(rows, relationConfig.referenceKey),
          fields: relationConfig.fields,
          filter: relationConfig.filter,
          orderBy: relationConfig.orderBy,
        });
        return [relationName, relationRows] as const;
      } catch (error) {
        throw new Error(
          `Inventory relation "${relationName}" probe failed for table ` +
            `"${relationConfig.table}": ${errorMessage(error)}`,
        );
      }
    }),
  );

  // An empty catalog is valid, but every row in a normal page must survive
  // the exact mapping and JSON wire contract before the connector is healthy.
  if (rows.length > 0) {
    const relationData = new Map(relationEntries);
    for (const row of rows) {
      try {
        validateInventoryItemWireContract(
          mapRowToInventoryItem(row, resourceConfig, relationData),
          getMappedImageValues(row, resourceConfig, relationData),
        );
      } catch (error) {
        throw new Error(`Inventory resource probe failed for sample row: ${errorMessage(error)}`);
      }
    }
  }

  const statusColumn = resourceConfig.fields['status'];
  if (!statusColumn) return [];

  const observedStatuses = await probeStatusValues(dbAdapter, resourceConfig, statusColumn, rows);

  return Array.from(
    new Set(
      observedStatuses.flatMap((value) => {
        const normalizedValue = value === null || value === undefined ? '' : String(value).trim();
        return normalizedValue && !resolveInventoryStatus(value, resourceConfig.statusValues)
          ? [normalizedValue]
          : [];
      }),
    ),
  )
    .sort()
    .slice(0, UNKNOWN_STATUS_VALUE_LIMIT);
}

/**
 * Collects the source status values the merchant's catalog actually uses.
 *
 * The sampled row alone is not evidence: a catalog where 8,000 of 10,000 rows
 * carry a newly introduced `under_offer` reports nothing unless the single
 * sampled row happens to carry it (#23293). Ask the adapter for the distinct
 * values instead, and keep the sampled row's value in the answer so this is
 * always a superset of what the previous behaviour saw.
 */
async function probeStatusValues(
  dbAdapter: DatabaseAdapter,
  resourceConfig: InventoryResourceConfig,
  statusColumn: string,
  sampledRows: Record<string, unknown>[],
): Promise<unknown[]> {
  const sampledStatuses = sampledRows.map((row) => resolveColumnValue(row, statusColumn));
  if (!dbAdapter.distinctValues) return sampledStatuses;

  try {
    const distinctStatuses = await dbAdapter.distinctValues({
      ...(resourceConfig.schema ? { schema: resourceConfig.schema } : {}),
      table: resourceConfig.table,
      column: statusColumn,
      limit: UNKNOWN_STATUS_VALUE_LIMIT,
      scanLimit: UNKNOWN_STATUS_SCAN_LIMIT,
      ...(resourceConfig.baseFilter ? { baseFilter: resourceConfig.baseFilter } : {}),
    });
    return [...sampledStatuses, ...distinctStatuses];
  } catch {
    // This query is a diagnostic, not a health signal — the status column
    // itself is already exercised by the sample query above, which does fail
    // the probe. Never turn a healthy resource unhealthy over the diagnostic.
    return sampledStatuses;
  }
}

/**
 * One operator-facing line naming the unmapped source status values and what
 * the connector does with them, or `null` when every value is mapped. Shared
 * by `npm run validate` and the startup log so neither can stay silent while
 * listings are quietly withheld from customers.
 */
export function formatUnknownStatusWarning(
  unknownStatusValues: readonly string[],
  unknownStatusPolicy: UnknownStatusPolicy | undefined,
): string | null {
  if (unknownStatusValues.length === 0) return null;

  const values = unknownStatusValues.map((value) => JSON.stringify(value)).join(', ');
  return (
    `Unmapped inventory status values found in the source: ${values}. ` +
    `Every listing carrying one of them is reported as ${unknownStatusPolicy ?? 'DRAFT'} ` +
    'and is never offered to customers. ' +
    'Map them under resources.inventory.statusValues.'
  );
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
