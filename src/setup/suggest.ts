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
  toColumn: string;
  relationType: 'images' | 'features' | 'generic';
  confidence: 'high' | 'medium' | 'low';
}

// Standard field mappings — ordered by priority
const FIELD_PATTERNS: { target: string; patterns: RegExp[]; type: 'field' | 'attribute' }[] = [
  {
    target: 'title',
    patterns: [/^title$/i, /^name$/i, /^product_?name$/i, /^listing_?name$/i],
    type: 'field',
  },
  {
    target: 'price',
    patterns: [/^price$/i, /^cost$/i, /^amount$/i, /^sale_?price$/i],
    type: 'field',
  },
  { target: 'currency', patterns: [/^currency$/i, /^currency_?code$/i], type: 'field' },
  { target: 'category', patterns: [/^category$/i, /^type$/i, /^product_?type$/i], type: 'field' },
  { target: 'status', patterns: [/^status$/i, /^state$/i, /^listing_?status$/i], type: 'field' },
  {
    target: 'description',
    patterns: [/^description$/i, /^desc$/i, /^details$/i, /^body$/i],
    type: 'field',
  },
  {
    target: 'images',
    patterns: [/^images?$/i, /^image_?urls?$/i, /^photos?$/i, /^photo_?urls?$/i],
    type: 'field',
  },
];

// Attribute patterns — more relaxed matching
const ATTRIBUTE_PATTERNS: { target: string; patterns: RegExp[] }[] = [
  { target: 'make', patterns: [/make/i, /brand/i, /manufacturer/i] },
  { target: 'model', patterns: [/model/i] },
  { target: 'year', patterns: [/^year$/i, /^model_?year$/i, /^production_?year$/i] },
  { target: 'color', patterns: [/^color$/i, /^colour$/i] },
  // search_inventory reads attributes.kilometers (mileage is a fallback alias).
  { target: 'kilometers', patterns: [/^mileage$/i, /^kilometers$/i, /^km$/i, /^odometer$/i] },
  { target: 'fuelType', patterns: [/fuel/i] },
  { target: 'transmission', patterns: [/transmission/i, /gearbox/i] },
  { target: 'enginePower', patterns: [/engine/i, /power/i, /horsepower/i, /hp$/i] },
  { target: 'drivetrain', patterns: [/drivetrain/i, /drive_?type/i, /^4wd$/i, /^awd$/i] },
  // A per-row customer-facing listing page. Written to `attributes.url`
  // (see wizard.ts's `suggestedAttributes` lookup), which
  // `resolvePublicListingUrl` already reads — without this, every default AI
  // card renders a dead 🔗 after a successful connector Test connection
  // (#25311). `permalink`/`href`/`canonical_url`/`product_link`/`page_url`
  // are the same idea under the column names a Woo/WordPress-shaped catalog
  // actually uses (#28246).
  {
    target: 'url',
    patterns: [
      /^url$/i,
      /^listing_?url$/i,
      /^link$/i,
      /^product_?url$/i,
      /^permalink$/i,
      /^href$/i,
      /^canonical_?url$/i,
      /^product_?link$/i,
      /^page_?url$/i,
    ],
  },
];

/**
 * Whether a column name matches the listing-URL naming conventions above,
 * independent of `suggestFieldMappings`' one-match-per-target pass. A second
 * column that also looks like a listing URL (e.g. both `url` and `permalink`
 * exist on the same table) never gets a `suggestedAttributes` entry — the
 * first match already claimed the `url` target — so a manual "additional
 * attribute" selection of that second column needs its own check to still
 * publish under the canonical `attributes.url` key instead of the raw column
 * name (#28246).
 */
export function isListingUrlColumn(columnName: string): boolean {
  const urlPatterns = ATTRIBUTE_PATTERNS.find((entry) => entry.target === 'url')!.patterns;
  return urlPatterns.some((pattern) => pattern.test(columnName));
}

// Columns to suggest as published filter
const PUBLISHED_PATTERNS = [
  /^published$/i,
  /^is_?active$/i,
  /^active$/i,
  /^is_?published$/i,
  /^visible$/i,
];

// Columns to suggest as soft-delete filter
const SOFT_DELETE_PATTERNS = [/^deleted_?at$/i, /^removed_?at$/i, /^archived_?at$/i];

// Image table indicators
const IMAGE_COLUMN_PATTERNS = [/url$/i, /^image/i, /^photo/i, /^picture/i, /^thumbnail/i, /^src$/i];

// A type/kind/category-like column on an image relation table. When present,
// it discriminates customer-facing gallery/featured photos from thumbnails,
// icons, and invoices the same table also stores (see the README's
// `type = 'gallery' OR type = 'featured'` example).
const IMAGE_TYPE_COLUMN_PATTERNS = [
  /^type$/i,
  /^kind$/i,
  /^category$/i,
  /^role$/i,
  /^image_?type$/i,
  /^photo_?type$/i,
];

// A composite FK's "from" columns that typically discriminate a shared/multi-tenant
// deployment rather than identify a specific parent row. Excluding these from a
// composite group leaves the column that still uniquely identifies the row in the
// common single-tenant / dedicated-DB deployment this connector targets.
const TENANT_COLUMN_PATTERNS = [
  /^tenant_?id$/i,
  /^org(anization)?_?id$/i,
  /^account_?id$/i,
  /^shop_?id$/i,
  /^store_?id$/i,
  /^merchant_?id$/i,
  /^company_?id$/i,
];

export function suggestFieldMappings(columns: IntrospectedColumn[]): FieldSuggestion[] {
  const suggestions: FieldSuggestion[] = [];
  const usedColumns = new Set<string>();

  // First pass: match standard fields (high-priority)
  for (const { target, patterns, type } of FIELD_PATTERNS) {
    let matchedTarget = false;
    for (const col of columns) {
      if (matchedTarget) break;
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
          matchedTarget = true;
          break;
        }
      }
    }
  }

  // Second pass: match attributes
  for (const { target, patterns } of ATTRIBUTE_PATTERNS) {
    let matchedTarget = false;
    for (const col of columns) {
      if (matchedTarget) break;
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
          matchedTarget = true;
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

/**
 * Find a type/kind/category-like column on an images relation table, used to
 * offer a `filter:` clause that keeps only customer-facing photos. Returns
 * null when no such column exists — plain photo-only tables get no filter,
 * which is not a regression from today's unfiltered behavior.
 */
export function suggestImageTypeColumn(columns: IntrospectedColumn[]): string | null {
  for (const col of columns) {
    if (col.isPrimaryKey) continue;
    for (const pattern of IMAGE_TYPE_COLUMN_PATTERNS) {
      if (pattern.test(col.name)) return col.name;
    }
  }
  return null;
}

/**
 * Pick the single column pair to use for a (possibly composite) FK constraint
 * group. A single-column group is used as-is. For a composite group, prefer
 * the pair whose "from" column doesn't look like a tenant/shared discriminator
 * — that column alone still uniquely identifies the parent row in a
 * single-tenant deployment. Returns null when the heuristic can't identify
 * exactly one such pair (0 or multiple candidates), since guessing wrong would
 * silently join the wrong rows.
 */
function pickRepresentativePair(group: ForeignKeyInfo[]): ForeignKeyInfo | null {
  if (group.length === 1) return group[0]!;

  const nonTenantPairs = group.filter(
    (fk) => !TENANT_COLUMN_PATTERNS.some((p) => p.test(fk.fromColumn)),
  );
  if (nonTenantPairs.length !== 1) return null;
  return nonTenantPairs[0]!;
}

function normalizeIdent(name: string): string {
  return name.replaceAll(/[_-]/g, '').toLowerCase();
}

function stemWithoutId(name: string): string {
  return normalizeIdent(name.replace(/_?id$/i, ''));
}

function looksLikeJoinColumn(name: string): boolean {
  return /_id$/i.test(name) || /Id$/.test(name) || /ID$/.test(name);
}

/** Classify a child table the same way FK-discovered relations are typed. */
export function classifyRelationType(table: IntrospectedTable): RelationSuggestion['relationType'] {
  const hasImageColumns = table.columns.some((col) =>
    IMAGE_COLUMN_PATTERNS.some((p) => p.test(col.name)),
  );
  if (hasImageColumns) return 'images';
  if (table.columns.length <= 5) return 'features';
  return 'generic';
}

/**
 * Name-match heuristic for a child table that has no FOREIGN KEY pointing at
 * the inventory object (views cannot be FK targets; unconstrained catalogues
 * often store `product_id` / `car_id` without a constraint). Prefers
 * `<table>_id` / `<table>Id` (and the singular form), then a column that
 * shares the inventory id name, then a unique `*_id` column. Never picks the
 * child's own `id` primary key.
 */
export function suggestJoinColumn(
  mainTable: string,
  mainIdColumn: string,
  childColumns: IntrospectedColumn[],
): string | null {
  const mainNorm = normalizeIdent(mainTable);
  const mainSingularNorm =
    mainNorm.endsWith('s') && mainNorm.length > 1 ? mainNorm.slice(0, -1) : mainNorm;

  let tableIdMatch: string | undefined;
  let sharedIdMatch: string | undefined;
  const idLike: string[] = [];

  for (const col of childColumns) {
    if (col.isPrimaryKey && normalizeIdent(col.name) === 'id') continue;

    const stem = stemWithoutId(col.name);
    if (looksLikeJoinColumn(col.name) && (stem === mainNorm || stem === mainSingularNorm)) {
      tableIdMatch ??= col.name;
      continue;
    }
    if (col.name === mainIdColumn) {
      sharedIdMatch ??= col.name;
      continue;
    }
    if (looksLikeJoinColumn(col.name)) idLike.push(col.name);
  }

  if (tableIdMatch) return tableIdMatch;
  if (sharedIdMatch) return sharedIdMatch;
  return idLike.length === 1 ? idLike[0]! : null;
}

export function suggestRelations(
  mainTable: string,
  tables: IntrospectedTable[],
  foreignKeys: ForeignKeyInfo[],
): RelationSuggestion[] {
  const suggestions: RelationSuggestion[] = [];

  // introspectForeignKeys reports one row per column pair, all sharing a
  // constraintName. Regroup them before doing anything else so a composite
  // foreign key's pairs are considered together instead of as independent
  // single-column relations.
  const byConstraint = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const key = `${fk.fromTable}::${fk.constraintName}`;
    const group = byConstraint.get(key);
    if (group) group.push(fk);
    else byConstraint.set(key, [fk]);
  }

  // Find tables that have a foreign key pointing to the main table.
  // RelationConfig only models a single foreignKey/referenceKey pair, so a
  // composite foreign key (constraint group with more than one column pair)
  // can't be expressed in full. Rather than dropping the whole relation —
  // which silently ships child rows (e.g. photos) with no way to join them
  // back — pick the one column pair that still identifies a specific parent
  // row (see pickRepresentativePair). If the heuristic can't tell which
  // column that is, fall back to skipping, same as before.
  const relatedFks = [...byConstraint.values()]
    .filter((group) => group[0]!.toTable === mainTable)
    .map((group) => pickRepresentativePair(group))
    .filter((fk): fk is ForeignKeyInfo => fk !== null);

  for (const fk of relatedFks) {
    const relatedTable = tables.find((t) => t.name === fk.fromTable);
    if (!relatedTable) continue;

    const relationType = classifyRelationType(relatedTable);
    suggestions.push({
      table: fk.fromTable,
      foreignKeyColumn: fk.fromColumn,
      toColumn: fk.toColumn,
      relationType,
      confidence: relationType === 'images' ? 'high' : 'low',
    });
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
export const TEXT_TYPES = new Set([
  'text',
  'character varying',
  'varchar',
  'char',
  'character',
  'name',
  'citext',
]);

/**
 * Whether PostgreSQL can safely apply ILIKE to an introspected column. Tables
 * and views report citext as USER-DEFINED, while materialized views report its
 * formatted type directly.
 */
export function isTextColumn(column: Pick<IntrospectedColumn, 'type' | 'udtName'>): boolean {
  const type = column.type.trim().toLowerCase();
  return (
    TEXT_TYPES.has(type) ||
    (type === 'user-defined' && column.udtName?.trim().toLowerCase() === 'citext')
  );
}

// Columns likely useful for text search
const SEARCHABLE_PATTERNS: RegExp[] = [
  /^title$/i,
  /^name$/i,
  /^product_?name$/i,
  /^listing_?name$/i,
  /^description$/i,
  /^desc$/i,
  /^details$/i,
  /^body$/i,
  /make/i,
  /model/i,
  /brand/i,
  /manufacturer/i,
];

// Numeric DB types
const NUMERIC_TYPES = new Set([
  'integer',
  'bigint',
  'smallint',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'float',
  'int',
  'int4',
  'int8',
]);

// USER-DEFINED types that report exactly like an enum in information_schema
// (namespace outside pg_catalog) but are actually opaque extension types —
// they cannot be safely rendered as a string attribute either. Extend as
// more of these show up.
const NON_ENUM_EXTENSION_UDT_NAMES = new Set(['geometry', 'geography']);

/**
 * Whether a column is safe to expose as a free-form inventory attribute — the
 * same text/numeric/enum allowlist `suggestFilterableColumns` already applies
 * to filters. Excludes binary and other opaque types (bytea, tsvector,
 * geometry/geography, arrays of any of those, etc.): node-postgres returns
 * those as Buffers or other non-JSON-safe values, and `JSON.stringify`
 * mangles a Buffer into `{"type":"Buffer","data":[...]}` on the wire —
 * inflating every response without ever rendering as a photo.
 */
export function isAttributeEligibleColumn(
  column: Pick<IntrospectedColumn, 'type' | 'udtName'>,
): boolean {
  const normalizedType = column.type.trim().toLowerCase();
  if (isTextColumn(column)) return true;
  if (NUMERIC_TYPES.has(normalizedType)) return true;
  if (normalizedType === 'user-defined') {
    const udtName = column.udtName?.trim().toLowerCase() ?? '';
    return !NON_ENUM_EXTENSION_UDT_NAMES.has(udtName);
  }
  return false;
}

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
    if (!isTextColumn(col)) continue;

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
  const usedFilterNames = new Set<string>();

  // Build a lookup: columnName → mapped name (field or attribute target)
  const columnToName = new Map<string, string>();
  for (const s of fieldMappings) {
    columnToName.set(s.columnName, s.suggestedMapping);
  }
  for (const attr of additionalAttributes) {
    if (!columnToName.has(attr)) columnToName.set(attr, attr);
  }

  for (const col of columns) {
    if (col.isPrimaryKey) continue;
    // Skip FK and timestamp columns
    if (/Id$/.test(col.name) || /_id$/.test(col.name)) continue;
    if (/At$/.test(col.name) || /_at$/.test(col.name)) continue;

    const mappedName = columnToName.get(col.name);
    if (!mappedName) continue;

    const isNumeric = NUMERIC_TYPES.has(col.type.toLowerCase());
    const isText = isTextColumn(col);
    // PostgreSQL reports enums as USER-DEFINED (citext is already `isText`).
    // The live `=` branch casts these with `::text ILIKE`, so color / fuelType
    // / transmission enums should be string-filterable the way status already is.
    const isEnum = col.type.trim().toLowerCase() === 'user-defined';

    // Kasbly always requests ACTIVE inventory. A mapped source-status column
    // must therefore be exposed as the canonical `status` filter, including
    // PostgreSQL enums and integer status codes.
    if (mappedName === 'status') {
      if (!usedFilterNames.has('status')) {
        suggestions.push({
          columnName: col.name,
          filterName: 'status',
          filterType: 'string',
          confidence: 'high',
        });
        usedFilterNames.add('status');
      }
      continue;
    }

    if (isNumeric) {
      const filterNameSuffix = mappedName.charAt(0).toUpperCase() + mappedName.slice(1);
      const minFilterName = `min${filterNameSuffix}`;
      const maxFilterName = `max${filterNameSuffix}`;
      if (!usedFilterNames.has(minFilterName)) {
        suggestions.push({
          columnName: col.name,
          filterName: minFilterName,
          filterType: 'gte',
          confidence: 'high',
        });
        usedFilterNames.add(minFilterName);
      }
      if (!usedFilterNames.has(maxFilterName)) {
        suggestions.push({
          columnName: col.name,
          filterName: maxFilterName,
          filterType: 'lte',
          confidence: 'high',
        });
        usedFilterNames.add(maxFilterName);
      }
    } else if (isText || isEnum) {
      // Only suggest string filters for columns with bounded domains (make, fuelType, etc.)
      // Skip very free-text columns like title, description
      const FREE_TEXT = new Set(['title', 'description', 'desc', 'details', 'body']);
      if (FREE_TEXT.has(mappedName.toLowerCase())) continue;

      if (!usedFilterNames.has(mappedName)) {
        suggestions.push({
          columnName: col.name,
          filterName: mappedName,
          filterType: 'string',
          confidence: 'medium',
        });
        usedFilterNames.add(mappedName);
      }
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
