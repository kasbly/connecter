import type { IntrospectedColumn, IntrospectedTable, ForeignKeyInfo } from './introspect.js';

export interface FieldSuggestion {
  columnName: string;
  suggestedMapping: string;
  confidence: 'high' | 'medium' | 'low';
  mappingType: 'field' | 'attribute';
}

export interface RelationSuggestion {
  table: string;
  foreignKeyColumn: string;
  relationType: 'images' | 'features' | 'generic';
  confidence: 'high' | 'medium' | 'low';
}

// Standard field mappings — ordered by priority
const FIELD_PATTERNS: { target: string; patterns: RegExp[]; type: 'field' | 'attribute' }[] = [
  { target: 'title', patterns: [/^title$/i, /^name$/i, /^product_?name$/i, /^listing_?name$/i], type: 'field' },
  { target: 'price', patterns: [/^price$/i, /^cost$/i, /^amount$/i, /^sale_?price$/i], type: 'field' },
  { target: 'currency', patterns: [/^currency$/i, /^currency_?code$/i], type: 'field' },
  { target: 'category', patterns: [/^category$/i, /^type$/i, /^product_?type$/i], type: 'field' },
  { target: 'status', patterns: [/^status$/i, /^state$/i, /^listing_?status$/i], type: 'field' },
  { target: 'description', patterns: [/^description$/i, /^desc$/i, /^details$/i, /^body$/i], type: 'field' },
];

// Attribute patterns — more relaxed matching
const ATTRIBUTE_PATTERNS: { target: string; patterns: RegExp[] }[] = [
  { target: 'make', patterns: [/make/i, /brand/i, /manufacturer/i] },
  { target: 'model', patterns: [/model/i] },
  { target: 'year', patterns: [/^year$/i, /^model_?year$/i, /^production_?year$/i] },
  { target: 'color', patterns: [/^color$/i, /^colour$/i] },
  { target: 'mileage', patterns: [/^mileage$/i, /^kilometers$/i, /^km$/i, /^odometer$/i] },
  { target: 'fuelType', patterns: [/fuel/i] },
  { target: 'transmission', patterns: [/transmission/i, /gearbox/i] },
  { target: 'enginePower', patterns: [/engine/i, /power/i, /horsepower/i, /hp$/i] },
  { target: 'drivetrain', patterns: [/drivetrain/i, /drive_?type/i, /^4wd$/i, /^awd$/i] },
];

// Columns to suggest as published filter
const PUBLISHED_PATTERNS = [/^published$/i, /^is_?active$/i, /^active$/i, /^is_?published$/i, /^visible$/i];

// Columns to suggest as soft-delete filter
const SOFT_DELETE_PATTERNS = [/^deleted_?at$/i, /^removed_?at$/i, /^archived_?at$/i];

// Image table indicators
const IMAGE_COLUMN_PATTERNS = [/url$/i, /^image/i, /^photo/i, /^picture/i, /^thumbnail/i, /^src$/i];

export function suggestFieldMappings(
  columns: IntrospectedColumn[],
): FieldSuggestion[] {
  const suggestions: FieldSuggestion[] = [];
  const usedColumns = new Set<string>();

  // First pass: match standard fields (high-priority)
  for (const { target, patterns, type } of FIELD_PATTERNS) {
    for (const col of columns) {
      if (usedColumns.has(col.name)) continue;
      for (const pattern of patterns) {
        if (pattern.test(col.name)) {
          suggestions.push({
            columnName: col.name,
            suggestedMapping: target,
            confidence: 'high',
            mappingType: type,
          });
          usedColumns.add(col.name);
          break;
        }
      }
    }
  }

  // Second pass: match attributes
  for (const { target, patterns } of ATTRIBUTE_PATTERNS) {
    for (const col of columns) {
      if (usedColumns.has(col.name)) continue;
      if (col.isPrimaryKey) continue;
      // Skip foreign keys (end with Id/id)
      if (/Id$/.test(col.name) || /_id$/.test(col.name)) continue;
      // Skip timestamps
      if (/At$/.test(col.name) || /_at$/.test(col.name)) continue;

      for (const pattern of patterns) {
        if (pattern.test(col.name)) {
          suggestions.push({
            columnName: col.name,
            suggestedMapping: target,
            confidence: 'medium',
            mappingType: 'attribute',
          });
          usedColumns.add(col.name);
          break;
        }
      }
    }
  }

  return suggestions;
}

export function suggestPublishedColumn(columns: IntrospectedColumn[]): string | null {
  for (const col of columns) {
    for (const pattern of PUBLISHED_PATTERNS) {
      if (pattern.test(col.name)) return col.name;
    }
  }
  return null;
}

export function suggestSoftDeleteColumn(columns: IntrospectedColumn[]): string | null {
  for (const col of columns) {
    for (const pattern of SOFT_DELETE_PATTERNS) {
      if (pattern.test(col.name)) return col.name;
    }
  }
  return null;
}

export function suggestRelations(
  mainTable: string,
  tables: IntrospectedTable[],
  foreignKeys: ForeignKeyInfo[],
): RelationSuggestion[] {
  const suggestions: RelationSuggestion[] = [];

  // Find tables that have a foreign key pointing to the main table
  const relatedFks = foreignKeys.filter((fk) => fk.toTable === mainTable);

  for (const fk of relatedFks) {
    const relatedTable = tables.find((t) => t.name === fk.fromTable);
    if (!relatedTable) continue;

    // Check if it's an image table
    const hasImageColumns = relatedTable.columns.some((col) =>
      IMAGE_COLUMN_PATTERNS.some((p) => p.test(col.name)),
    );

    if (hasImageColumns) {
      suggestions.push({
        table: fk.fromTable,
        foreignKeyColumn: fk.fromColumn,
        relationType: 'images',
        confidence: 'high',
      });
    } else if (relatedTable.columns.length <= 5) {
      // Small related tables are likely feature/tag tables
      suggestions.push({
        table: fk.fromTable,
        foreignKeyColumn: fk.fromColumn,
        relationType: 'features',
        confidence: 'medium',
      });
    } else {
      suggestions.push({
        table: fk.fromTable,
        foreignKeyColumn: fk.fromColumn,
        relationType: 'generic',
        confidence: 'low',
      });
    }
  }

  return suggestions;
}

// =========================================================================
// Searchable & Filterable Suggestions
// =========================================================================

export interface SearchableColumnSuggestion {
  columnName: string;
  confidence: 'high' | 'medium';
}

export interface FilterableColumnSuggestion {
  columnName: string;
  filterName: string;
  filterType: 'string' | 'number' | 'gte' | 'lte';
  confidence: 'high' | 'medium';
}

// Text-like DB types that make sense for ILIKE search
const TEXT_TYPES = new Set([
  'text', 'character varying', 'varchar', 'char', 'character',
  'name', 'citext',
]);

// Columns likely useful for text search
const SEARCHABLE_PATTERNS: RegExp[] = [
  /^title$/i, /^name$/i, /^product_?name$/i, /^listing_?name$/i,
  /^description$/i, /^desc$/i, /^details$/i, /^body$/i,
  /make/i, /model/i, /brand/i, /manufacturer/i,
];

// Numeric DB types
const NUMERIC_TYPES = new Set([
  'integer', 'bigint', 'smallint', 'numeric', 'decimal',
  'real', 'double precision', 'float', 'int', 'int4', 'int8',
]);

/**
 * Suggest columns good for full-text ILIKE search.
 * Prefers text columns whose names match common searchable patterns.
 */
export function suggestSearchableColumns(
  columns: IntrospectedColumn[],
): SearchableColumnSuggestion[] {
  const suggestions: SearchableColumnSuggestion[] = [];

  for (const col of columns) {
    if (col.isPrimaryKey) continue;
    if (!TEXT_TYPES.has(col.type.toLowerCase())) continue;

    const matchesPattern = SEARCHABLE_PATTERNS.some((p) => p.test(col.name));
    if (matchesPattern) {
      suggestions.push({ columnName: col.name, confidence: 'high' });
    }
  }

  return suggestions;
}

/**
 * Suggest columns good for exact-match or range filtering.
 * Uses the already-resolved field/attribute mappings to produce meaningful filter names.
 */
export function suggestFilterableColumns(
  columns: IntrospectedColumn[],
  fieldMappings: FieldSuggestion[],
  additionalAttributes: string[],
): FilterableColumnSuggestion[] {
  const suggestions: FilterableColumnSuggestion[] = [];

  // Build a lookup: columnName → mapped name (field or attribute target)
  const columnToName = new Map<string, string>();
  for (const s of fieldMappings) {
    columnToName.set(s.columnName, s.suggestedMapping);
  }
  for (const attr of additionalAttributes) {
    columnToName.set(attr, attr);
  }

  for (const col of columns) {
    if (col.isPrimaryKey) continue;
    // Skip FK and timestamp columns
    if (/Id$/.test(col.name) || /_id$/.test(col.name)) continue;
    if (/At$/.test(col.name) || /_at$/.test(col.name)) continue;

    const mappedName = columnToName.get(col.name);
    if (!mappedName) continue;

    const isNumeric = NUMERIC_TYPES.has(col.type.toLowerCase());
    const isText = TEXT_TYPES.has(col.type.toLowerCase());

    if (mappedName === 'price' && isNumeric) {
      // Price gets two filters: minPrice (gte) and maxPrice (lte)
      suggestions.push({
        columnName: col.name,
        filterName: 'minPrice',
        filterType: 'gte',
        confidence: 'high',
      });
      suggestions.push({
        columnName: col.name,
        filterName: 'maxPrice',
        filterType: 'lte',
        confidence: 'high',
      });
    } else if (isNumeric) {
      suggestions.push({
        columnName: col.name,
        filterName: mappedName,
        filterType: 'number',
        confidence: 'medium',
      });
    } else if (isText) {
      // Only suggest text filters for columns with bounded domains (make, fuelType, etc.)
      // Skip very free-text columns like title, description
      const FREE_TEXT = new Set(['title', 'description', 'desc', 'details', 'body']);
      if (FREE_TEXT.has(mappedName.toLowerCase())) continue;

      suggestions.push({
        columnName: col.name,
        filterName: mappedName,
        filterType: 'string',
        confidence: 'medium',
      });
    }
  }

  return suggestions;
}

export function suggestIdColumn(columns: IntrospectedColumn[]): string | null {
  // Prefer primary key
  const pk = columns.find((c) => c.isPrimaryKey);
  if (pk) return pk.name;

  // Fall back to 'id'
  const idCol = columns.find((c) => c.name === 'id');
  return idCol?.name ?? null;
}

export function suggestUpdatedAtColumn(columns: IntrospectedColumn[]): string | null {
  const patterns = [/^updated_?at$/i, /^modified_?at$/i, /^last_?updated$/i, /^changed_?at$/i];
  for (const col of columns) {
    for (const pattern of patterns) {
      if (pattern.test(col.name)) return col.name;
    }
  }
  return null;
}
