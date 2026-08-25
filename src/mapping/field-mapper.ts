import {
  INVENTORY_STATUSES,
  type InventoryResourceConfig,
  type InventoryStatus,
  type RelationConfig,
  type StatusValuesConfig,
} from '../config/config.types.js';
import { z } from 'zod';

export interface ConnectorInventoryItem {
  externalId: string;
  title: string;
  description: string | null;
  price: number;
  currency: string;
  category: string;
  status: string;
  images: string[];
  attributes: Record<string, unknown>;
  updatedAt: string | null;
}

/**
 * Keep the standalone producer on the same strict inventory wire contract its
 * consumers enforce. Validation happens after JSON serialization so values
 * such as NaN cannot become a silent `null` on the wire.
 */
const connectorInventoryItemWireSchema = z
  .object({
    externalId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().nullable(),
    price: z.number().finite(),
    currency: z.string().trim().min(1),
    category: z.string(),
    status: z.string(),
    images: z.array(z.string().trim().min(1)),
    attributes: z.record(z.string(), z.unknown()),
    updatedAt: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid updatedAt date')
      .nullable(),
  })
  .strict();

function formatWireIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : 'response'}: ${issue.message}`)
    .join('; ');
}

/** Validate one mapped item as it will actually be sent through JSON. */
export function validateInventoryItemWireContract(
  item: ConnectorInventoryItem,
  mappedImageValues: unknown[] = [],
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(item);
  } catch (error) {
    throw new Error(`Inventory sample cannot be serialized: ${errorMessage(error)}`);
  }

  const parsed = connectorInventoryItemWireSchema.safeParse(JSON.parse(serialized) as unknown);
  if (!parsed.success) {
    throw new Error(
      `Inventory sample violates wire contract: ${formatWireIssues(parsed.error.issues)}`,
    );
  }

  const malformedImageFields = mappedImageValues.flatMap((value, index) =>
    getMalformedImageValueErrors(
      value,
      `images${mappedImageValues.length > 1 ? `[${index}]` : ''}`,
    ),
  );
  if (malformedImageFields.length > 0) {
    throw new Error(`Inventory sample violates wire contract: ${malformedImageFields.join('; ')}`);
  }
}

function getMalformedImageValueErrors(value: unknown, path: string): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      getMalformedImageValueErrors(entry, `${path}[${index}]`),
    );
  }
  if (typeof value !== 'string') return [`${path}: expected a string or array of strings`];

  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((entry, index) => getMalformedImageValueErrors(entry, `${path}[${index}]`))
      : [`${path}: JSON image value must be an array`];
  } catch {
    return [`${path}: invalid JSON image array`];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_STATUS_VALUES: Required<StatusValuesConfig> = {
  ACTIVE: ['ACTIVE', 'active'],
  DRAFT: ['DRAFT', 'draft'],
  RESERVED: ['RESERVED', 'reserved'],
  SOLD: ['SOLD', 'sold'],
  EXPIRED: ['EXPIRED', 'expired'],
};

/** Resolve a source-system status to Kasbly's closed inventory-status vocabulary. */
export function resolveInventoryStatus(
  value: unknown,
  statusValues: StatusValuesConfig | undefined,
): InventoryStatus | undefined {
  if (value === null || value === undefined) return undefined;

  const normalizedValue = String(value).trim().toLowerCase();
  if (!normalizedValue) return undefined;

  const mappings = statusValues ?? DEFAULT_STATUS_VALUES;
  return INVENTORY_STATUSES.find((status) =>
    (mappings[status] ?? DEFAULT_STATUS_VALUES[status]).some(
      (sourceValue) => sourceValue.trim().toLowerCase() === normalizedValue,
    ),
  );
}

/** Return source-system values that correspond to a Kasbly status filter. */
export function getSourceStatusValues(
  status: string,
  statusValues: StatusValuesConfig | undefined,
): string[] | undefined {
  if (!INVENTORY_STATUSES.includes(status as InventoryStatus)) return undefined;

  const inventoryStatus = status as InventoryStatus;
  return statusValues?.[inventoryStatus] ?? DEFAULT_STATUS_VALUES[inventoryStatus];
}

export function mapRowToInventoryItem(
  row: Record<string, unknown>,
  config: InventoryResourceConfig,
  relationData: Map<string, Map<string | number, Record<string, unknown>[]>>,
): ConnectorInventoryItem {
  const idValue = resolveColumnValue(row, config.idColumn);
  const externalId = String(idValue ?? '');

  // Map fixed fields
  const fields: Record<string, unknown> = {};
  for (const [mappedName, columnExpr] of Object.entries(config.fields)) {
    fields[mappedName] = resolveColumnValue(row, columnExpr);
  }

  // Map attributes
  const attributes: Record<string, unknown> = {};
  if (config.attributes) {
    for (const [attrName, columnExpr] of Object.entries(config.attributes)) {
      attributes[attrName] = resolveColumnValue(row, columnExpr);
    }
  }

  // Row images are emitted first so a primary image stored on the inventory row
  // remains first when it is supplemented by a related image table.
  const images = normalizeImageUrls(fields['images']);

  // Process relations
  if (config.relations) {
    for (const [relationName, relationConfig] of Object.entries(config.relations)) {
      const relData = relationData.get(relationName);
      const referenceValue = resolveColumnValue(row, relationConfig.referenceKey);
      const relRows = relData?.get(referenceValue as string | number) ?? [];

      if (relationConfig.imageUrlField) {
        for (const relationRow of relRows) {
          images.push(...normalizeImageUrls(relationRow[relationConfig.imageUrlField]));
        }
      } else if (relationConfig.flatten) {
        attributes[relationName] = relRows
          .map((r) => r[relationConfig.flatten!])
          .filter((v): v is string => typeof v === 'string');
      } else {
        attributes[relationName] = relRows;
      }
    }
  }

  // Determine updatedAt
  let updatedAt: string | null = null;
  if (config.updatedAtColumn) {
    const rawDate = resolveColumnValue(row, config.updatedAtColumn);
    if (rawDate) {
      updatedAt = rawDate instanceof Date ? rawDate.toISOString() : String(rawDate);
    }
  }

  return {
    externalId,
    title: String(fields['title'] ?? ''),
    description: typeof fields['description'] === 'string' ? fields['description'] : null,
    price: Number(fields['price'] ?? 0),
    currency: String(fields['currency'] ?? ''),
    category: String(fields['category'] ?? ''),
    // Treat a missing or newly introduced source value as non-sellable until
    // the merchant explicitly maps it in statusValues.
    status:
      resolveInventoryStatus(fields['status'], config.statusValues) ??
      config.unknownStatusPolicy ??
      'DRAFT',
    images,
    attributes,
    updatedAt,
  };
}

/**
 * Normalize a configured image field from PostgreSQL (which returns text arrays
 * as JavaScript arrays), a JSON array, or one URL into non-empty string URLs.
 */
export function normalizeImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeImageUrls);
  }

  if (typeof value !== 'string') return [];

  const url = value.trim();
  if (!url) return [];

  if (url.startsWith('[')) {
    try {
      const parsed = JSON.parse(url) as unknown;
      return Array.isArray(parsed) ? parsed.flatMap(normalizeImageUrls) : [];
    } catch {
      return [];
    }
  }

  return [url];
}

export function resolveColumnValue(row: Record<string, unknown>, columnExpr: string): unknown {
  // Handle literal string values wrapped in single quotes, e.g. "'KRW'"
  const literalMatch = /^'(.+)'$/.exec(columnExpr.trim());
  if (literalMatch) {
    return literalMatch[1];
  }

  // Handle quoted column names (PostgreSQL-style), e.g. '"makeEn"'
  const quotedMatch = /^"(.+)"$/.exec(columnExpr.trim());
  if (quotedMatch) {
    return row[quotedMatch[1]!];
  }

  // Plain column name
  return row[columnExpr.trim()];
}

export function getRelationConfigs(config: InventoryResourceConfig): [string, RelationConfig][] {
  if (!config.relations) return [];
  return Object.entries(config.relations);
}

/**
 * Extract the minimal set of SQL column expressions needed from the main table.
 * Avoids SELECT * by only requesting columns referenced in fields, attributes, and config.
 */
export function getRequiredColumns(config: InventoryResourceConfig): string[] {
  const columns = new Set<string>();

  // ID column
  columns.add(config.idColumn);

  // updatedAt column
  if (config.updatedAtColumn) {
    columns.add(config.updatedAtColumn);
  }

  // Field columns
  for (const columnExpr of Object.values(config.fields)) {
    // Skip literal values like "'KRW'"
    if (/^'.*'$/.test(columnExpr.trim())) continue;
    columns.add(columnExpr);
  }

  // Attribute columns
  if (config.attributes) {
    for (const columnExpr of Object.values(config.attributes)) {
      if (/^'.*'$/.test(columnExpr.trim())) continue;
      columns.add(columnExpr);
    }
  }

  // Parent columns referenced by relation foreign keys
  if (config.relations) {
    for (const relationConfig of Object.values(config.relations)) {
      columns.add(relationConfig.referenceKey);
    }
  }

  return Array.from(columns);
}
