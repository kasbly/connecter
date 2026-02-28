import type { InventoryResourceConfig, RelationConfig } from '../config/config.types.js';

export interface ConnectorInventoryItem {
  externalId: string;
  title: string;
  price: number;
  currency: string;
  category: string;
  status: string;
  images: string[];
  attributes: Record<string, unknown>;
  updatedAt: string | null;
}

export function mapRowToInventoryItem(
  row: Record<string, unknown>,
  config: InventoryResourceConfig,
  relationData: Map<string, Map<string | number, Record<string, unknown>[]>>,
): ConnectorInventoryItem {
  const idValue = row[config.idColumn];
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

  // Process relations
  let images: string[] = [];
  if (config.relations) {
    for (const [relationName, relationConfig] of Object.entries(config.relations)) {
      const relData = relationData.get(relationName);
      const relRows = relData?.get(idValue as string | number) ?? [];

      if (relationConfig.imageUrlField) {
        images = relRows
          .map((r) => r[relationConfig.imageUrlField!])
          .filter((url): url is string => typeof url === 'string' && url.length > 0);
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
  if (config.updatedAtColumn && row[config.updatedAtColumn]) {
    const rawDate = row[config.updatedAtColumn];
    updatedAt = rawDate instanceof Date ? rawDate.toISOString() : String(rawDate);
  }

  return {
    externalId,
    title: String(fields['title'] ?? ''),
    price: Number(fields['price'] ?? 0),
    currency: String(fields['currency'] ?? 'USD'),
    category: String(fields['category'] ?? ''),
    status: String(fields['status'] ?? 'ACTIVE'),
    images,
    attributes,
    updatedAt,
  };
}

function resolveColumnValue(
  row: Record<string, unknown>,
  columnExpr: string,
): unknown {
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

export function getRelationConfigs(
  config: InventoryResourceConfig,
): [string, RelationConfig][] {
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

  return Array.from(columns);
}
