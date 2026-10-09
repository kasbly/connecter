import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, select, confirm, checkbox, password } from '@inquirer/prompts';
import { parse } from 'dotenv';
import * as yaml from 'js-yaml';
import { loadConfig, parseConnectorConfig } from '../config/config.loader.js';
import type {
  ConnectorConfig,
  RelationConfig,
  UnknownStatusPolicy,
} from '../config/config.types.js';
import { introspectDatabase, type IntrospectedTable } from './introspect.js';
import {
  INVENTORY_STATUSES,
  type InventoryStatus,
  type StatusValuesConfig,
} from '../config/config.types.js';
import {
  suggestFieldMappings,
  suggestIdColumn,
  suggestUpdatedAtColumn,
  suggestPublishedColumn,
  suggestInStockFilter,
  suggestSoftDeleteColumn,
  suggestRelations,
  suggestSearchableColumns,
  suggestFilterableColumns,
  suggestImageTypeColumn,
  suggestJoinColumn,
  classifyRelationType,
  isTextColumn,
  getInStockFilterDefault,
  getSearchableColumnDefault,
  isAttributeEligibleColumn,
  isListingUrlColumn,
  type FilterableColumnSuggestion,
  type RelationSuggestion,
} from './suggest.js';
import { UNMAPPED_STATUS_FALLBACK } from '../mapping/field-mapper.js';
import { createDatabaseAdapter } from '../db/adapter.factory.js';
import {
  formatUnknownStatusWarning,
  formatUnservableImageWarning,
  formatUnservableListingUrlWarning,
  formatWireContractViolationWarning,
  isTransientProbeError,
  probeInventoryResource,
} from '../routes/health.route.js';
import { buildOrderByClause } from '../db/postgres.adapter.js';
import { getDefaultSort } from '../mapping/query-builder.js';

interface DatabaseTlsSettings {
  enabled: boolean;
  ca?: string;
  rejectUnauthorized: boolean;
}

export const FIELD_MAPPING_TARGETS = [
  'title',
  'price',
  'currency',
  'category',
  'status',
  'description',
  'images',
] as const;

type FieldMappingTarget = (typeof FIELD_MAPPING_TARGETS)[number];

export const UNMAPPED_FIELD_VALUE = '\0unmapped';
export const FIXED_VALUE_FIELD_VALUE = '\0fixed-value';
const FIXED_VALUE_FIELDS = new Set<FieldMappingTarget>(['currency', 'category', 'status']);

interface FieldMappingPrompt {
  message: string;
  choices: Array<{ name: string; value: string }>;
  default: string;
}

interface MappingColumn {
  name: string;
  type: string;
  udtName?: string;
}

function isCompatibleFieldColumn(field: FieldMappingTarget, column: MappingColumn): boolean {
  const normalizedType = column.type.trim().toLowerCase();
  if (field === 'price') {
    return /^(smallint|integer|bigint|decimal|numeric|real|double precision|float)/.test(
      normalizedType,
    );
  }

  if (field === 'images') {
    return /(char|text|json|xml|array)/.test(normalizedType);
  }

  if (field === 'status') {
    // PostgreSQL reports enum columns as USER-DEFINED, with the enum name in
    // udt_name. Integer status codes are common in older catalogues too.
    return (
      /(char|text|xml|enum|smallint|integer|boolean|bool)/.test(normalizedType) ||
      (normalizedType === 'user-defined' && Boolean(column.udtName?.trim()))
    );
  }

  if (
    field === 'title' ||
    field === 'currency' ||
    field === 'category' ||
    field === 'description'
  ) {
    return isTextColumn(column) || /(xml|enum)/.test(normalizedType);
  }

  return /(char|text|json|xml|enum)/.test(normalizedType);
}

/**
 * How many distinct source status values the wizard asks about. A high-cardinality
 * column would otherwise present one unanswerable prompt per value with no way out
 * but Ctrl-C, which discards the whole session. Anything past the cap — and anything
 * explicitly left unmapped — is covered by `unknownStatusPolicy`.
 */
export const STATUS_VALUE_PROMPT_LIMIT = 25;
export const STATUS_VALUE_SCAN_LIMIT = 5_000;

/**
 * Default answer for a status-value prompt: the Kasbly status the value is already
 * mapped to, else the status whose name matches the value case-insensitively, else
 * "leave unmapped". Never falls through to the first choice (ACTIVE), which would
 * silently make sold/reserved rows sellable on Enter.
 */
export function getStatusValueDefault(
  value: string,
  existingStatusValues?: StatusValuesConfig,
): InventoryStatus | typeof UNMAPPED_FIELD_VALUE {
  for (const status of INVENTORY_STATUSES) {
    if (existingStatusValues?.[status]?.includes(value)) return status;
  }
  if (value.toLowerCase() === 'true') return 'ACTIVE';
  if (value.toLowerCase() === 'false') return 'SOLD';
  const byName = INVENTORY_STATUSES.find((status) => status.toLowerCase() === value.toLowerCase());
  return byName ?? UNMAPPED_FIELD_VALUE;
}

async function collectStatusValues(
  db: Awaited<ReturnType<typeof introspectDatabase>>['db'],
  schema: string,
  table: string,
  column: string,
  idColumn: string,
  updatedAtColumn: string | null | undefined,
  existingStatusValues?: StatusValuesConfig,
): Promise<StatusValuesConfig> {
  // Without an explicit ORDER BY, Postgres serves the bounded scan below in
  // physical heap order, which skews toward old/never-updated rows and can miss
  // a status value that only shows up on rows changed after the scan cap on a
  // large table (#25985) — the same failure mode `distinctValues` in
  // postgres.adapter.ts guards against for the runtime `/health` probe. Follow
  // the resource's default sort (recency, falling back to id) here too, so this
  // sample sees the same rows that probe would.
  const sort = getDefaultSort({
    table,
    idColumn: quoteIfNeeded(idColumn),
    ...(updatedAtColumn ? { updatedAtColumn: quoteIfNeeded(updatedAtColumn) } : {}),
    fields: {},
  });
  const orderByClause = buildOrderByClause(sort);

  // Keep the distinct operation outside a bounded subquery. A bare DISTINCT must
  // inspect the complete merchant table before returning any values. Fetch one value
  // more than the wizard will prompt for: that extra row is the only evidence that
  // the column overflows the cap, and without it the warning below can never fire.
  const result = await db.raw<{ rows: Array<{ value: unknown }> }>(
    `SELECT DISTINCT "value" FROM (SELECT ?? AS "value" FROM ??.?? WHERE ?? IS NOT NULL ORDER BY ${orderByClause} LIMIT ?) AS "sampled_rows" LIMIT ?`,
    [column, schema, table, column, STATUS_VALUE_SCAN_LIMIT, STATUS_VALUE_PROMPT_LIMIT + 1],
  );
  const values = result.rows.map((row) => row.value);
  const distinctValues = Array.from(new Set(values.map((value) => String(value)))).sort();
  const presentedValues = distinctValues.slice(0, STATUS_VALUE_PROMPT_LIMIT);
  // The query stops one past the cap, so the true distinct count is unknown here —
  // report the overflow as a lower bound rather than inventing a total.
  if (distinctValues.length > presentedValues.length) {
    console.log(
      `\n"${column}" has more than ${STATUS_VALUE_PROMPT_LIMIT} distinct values. Mapping the first ${presentedValues.length}; the rest use the unknown-status policy chosen next.`,
    );
  }
  const statusValues: StatusValuesConfig = {};

  for (const value of presentedValues) {
    const status = await select<InventoryStatus | typeof UNMAPPED_FIELD_VALUE>({
      message: `Which Kasbly status matches "${value}"?`,
      default: getStatusValueDefault(value, existingStatusValues),
      choices: [
        ...INVENTORY_STATUSES.map((inventoryStatus) => ({
          name: inventoryStatus,
          value: inventoryStatus as InventoryStatus | typeof UNMAPPED_FIELD_VALUE,
        })),
        {
          name: 'Leave unmapped (use the unknown-status policy)',
          value: UNMAPPED_FIELD_VALUE as InventoryStatus | typeof UNMAPPED_FIELD_VALUE,
        },
      ],
    });
    if (status === UNMAPPED_FIELD_VALUE) continue;
    (statusValues[status] ??= []).push(value);
  }

  return statusValues;
}

/**
 * How many distinct values of a relation table's type/kind/category column
 * the wizard offers as filter choices. Mirrors STATUS_VALUE_PROMPT_LIMIT's
 * reasoning: an unbounded checkbox prompt for a high-cardinality column has
 * no good escape but Ctrl-C.
 */
export const IMAGE_TYPE_VALUE_SCAN_LIMIT = 5_000;
export const IMAGE_TYPE_VALUE_PROMPT_LIMIT = 25;

/**
 * Sample distinct non-null values of one column on a relation table, capped
 * so a high-cardinality or huge child table can't hang setup. Used to build
 * the images relation's `filter:` choices.
 *
 * A child table (e.g. one row per photo) is routinely *larger* than its
 * parent catalog, not smaller, so this is exposed to the same heap-order skew
 * `collectStatusValues` guards against for #25985: an unordered bounded scan
 * can miss a type value (e.g. a `'featured'` tag added to only the most
 * recently inserted rows) that never appears in the first
 * `IMAGE_TYPE_VALUE_SCAN_LIMIT` rows. When the relation table has a primary
 * key, order the scan by it (descending) as a best-effort recency proxy —
 * imperfect for non-sequential keys like UUIDs, but strictly better than an
 * arbitrary heap-order sample, and free since the column is always indexed.
 */
async function collectDistinctColumnValues(
  db: Awaited<ReturnType<typeof introspectDatabase>>['db'],
  schema: string,
  table: string,
  column: string,
  orderColumn?: string,
): Promise<string[]> {
  const orderByClause = orderColumn ? `ORDER BY ${quoteIfNeeded(orderColumn)} DESC ` : '';
  const result = await db.raw<{ rows: Array<{ value: unknown }> }>(
    `SELECT DISTINCT "value" FROM (SELECT ?? AS "value" FROM ??.?? WHERE ?? IS NOT NULL ${orderByClause}LIMIT ?) AS "sampled_rows" LIMIT ?`,
    [column, schema, table, column, IMAGE_TYPE_VALUE_SCAN_LIMIT, IMAGE_TYPE_VALUE_PROMPT_LIMIT + 1],
  );
  return Array.from(new Set(result.rows.map((row) => String(row.value)))).sort();
}

/**
 * The map key a relation config lives under is a disambiguated
 * `table__foreignKey` key so two FKs onto the same child table can't
 * collide (#26144) — it was never meant to double as the customer-facing
 * attribute name. A child table conventionally named `<MainTable><Noun>`
 * (e.g. `CarFeatures` off `Car`) publishes under just the noun, lower-cased
 * (`features`), matching the README's example and what `search_inventory`'s
 * AI card templates read from `attributes`. Falls back to the whole table
 * name (lower-cased) when it doesn't share the main table's prefix.
 */
export function derivePublishedRelationName(table: string, mainTable: string): string {
  const lowerTable = table.toLowerCase();
  const lowerMain = mainTable.toLowerCase();

  let noun = table;
  if (lowerTable.startsWith(`${lowerMain}s`) && lowerTable.length > lowerMain.length + 1) {
    // Plural main-table prefix, e.g. `cars_features` off a `car`/`cars` table.
    // Tested before the singular-prefix branch below since `lowerMain + 's'`
    // starting is a strict subset of `lowerMain` starting — the singular
    // branch would otherwise always win and this one would never run.
    noun = table.slice(mainTable.length + 1);
  } else if (lowerTable.startsWith(lowerMain) && lowerTable.length > lowerMain.length) {
    noun = table.slice(mainTable.length);
  }
  noun = noun.replace(/^[_-]+/, '') || table;

  return noun.charAt(0).toLowerCase() + noun.slice(1);
}

/** Build the selectable mapping choices for one standard inventory field. */
export function getFieldMappingPrompt(
  field: FieldMappingTarget,
  columns: Array<string | MappingColumn>,
  suggestedColumn?: string,
  keepFixedValue = false,
): FieldMappingPrompt {
  const columnNames = columns
    .filter(
      (column): column is string | MappingColumn =>
        typeof column === 'string' || isCompatibleFieldColumn(field, column),
    )
    .map((column) => (typeof column === 'string' ? column : column.name));
  const choices: FieldMappingPrompt['choices'] = [
    { name: 'Do not map this field', value: UNMAPPED_FIELD_VALUE },
    ...(FIXED_VALUE_FIELDS.has(field)
      ? [{ name: 'Use a fixed value for every row', value: FIXED_VALUE_FIELD_VALUE }]
      : []),
    ...columnNames.map((columnName) => ({
      name: columnName === suggestedColumn ? `${columnName} (suggested)` : columnName,
      value: columnName,
    })),
  ];

  return {
    message:
      field === 'images'
        ? 'Which column contains the images? (one URL, a PostgreSQL text array, or a JSON array; e.g. ["https://example.com/photo.jpg"]). Values must be absolute http(s) URLs \u2014 site-relative paths and bare filenames such as "/uploads/car-123.jpg" are dropped, and those listings reach customers without photos.'
        : `Which column contains the ${field}?`,
    choices,
    default:
      suggestedColumn && columnNames.includes(suggestedColumn)
        ? suggestedColumn
        : keepFixedValue && FIXED_VALUE_FIELDS.has(field)
          ? FIXED_VALUE_FIELD_VALUE
          : UNMAPPED_FIELD_VALUE,
  };
}

/** Build the required unique-listing-id prompt; never invent a column that is not on the table. */
export function getIdColumnPrompt(
  columns: Array<{ name: string }>,
  suggestedColumn?: string | null,
): { message: string; choices: Array<{ name: string; value: string }>; default?: string } {
  const columnNames = columns.map((column) => column.name);
  const defaultColumn =
    suggestedColumn && columnNames.includes(suggestedColumn) ? suggestedColumn : undefined;

  return {
    message: 'Which column is the unique listing id?',
    choices: columnNames.map((columnName) => ({
      name: columnName === defaultColumn ? `${columnName} (suggested)` : columnName,
      value: columnName,
    })),
    ...(defaultColumn ? { default: defaultColumn } : {}),
  };
}

/** Build the optional last-updated prompt; epoch/bigint columns can be left unmapped. */
export function getUpdatedAtColumnPrompt(
  columns: Array<{ name: string }>,
  suggestedColumn?: string | null,
): FieldMappingPrompt {
  const columnNames = columns.map((column) => column.name);
  const defaultColumn =
    suggestedColumn && columnNames.includes(suggestedColumn)
      ? suggestedColumn
      : UNMAPPED_FIELD_VALUE;

  return {
    message: 'Which column is the last-updated timestamp?',
    choices: [
      { name: 'Do not map this field', value: UNMAPPED_FIELD_VALUE },
      ...columnNames.map((columnName) => ({
        name: columnName === suggestedColumn ? `${columnName} (suggested)` : columnName,
        value: columnName,
      })),
    ],
    default: defaultColumn,
  };
}

export function toConfigLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * True for a host that only ever means "this machine" — `localhost`,
 * `127.0.0.1`, `::1`. Inside the bundled Compose deployment that machine is
 * the connector's own container, not the operator's host, so this is also
 * what flags the `bundled` + loopback DB_HOST trap (#28245).
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.trim().toLowerCase());
}

export function shouldDefaultToTls(host: string): boolean {
  return !isLoopbackHost(host);
}

/**
 * Fixed internal address of the Caddy container in the bundled Compose
 * deployment (`docker-compose.yml`). Trusting exactly this address keeps
 * forwarded client IPs — and therefore per-IP rate limiting and the audit
 * trail — honest for the deployment the wizard tells the operator to run.
 */
const BUNDLED_PROXY_ADDRESS = '172.30.0.2';

/** Reject a value that is a URL or a host:port rather than a bare DNS name. */
export function isPublicHostname(value: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
    value.trim(),
  );
}

/** Which start recipe the wizard's final "next steps" print block recommends. */
export type ProxyTopology = 'bundled' | 'custom' | 'none';

interface ProxyTopologySelection {
  topology: ProxyTopology;
  trustedProxies: string | undefined;
}

/**
 * The connector reads forwarded headers only from this allowlist, so the value
 * has to match the proxy actually deployed in front of it. `undefined` means no
 * proxy: the raw socket peer is used, which is the fail-closed default.
 *
 * The choice also decides the start recipe the wizard recommends at the end:
 * only `bundled` starts the Compose file's Caddy service, which is the only
 * topology Caddy's fixed internal address (172.30.0.2) is meaningful for.
 */
async function collectTrustedProxies(
  existing: string | undefined,
): Promise<ProxyTopologySelection> {
  const topology = await select({
    message: 'Which reverse proxy will sit in front of the connector?',
    choices: [
      {
        name: `The bundled Docker HTTPS proxy — Caddy at ${BUNDLED_PROXY_ADDRESS} (recommended)`,
        value: 'bundled' as const,
      },
      { name: 'A different proxy (enter its IPs/CIDRs)', value: 'custom' as const },
      { name: 'None — the connector is exposed directly', value: 'none' as const },
    ],
    default:
      existing === undefined || existing === BUNDLED_PROXY_ADDRESS
        ? ('bundled' as const)
        : ('custom' as const),
  });

  if (topology === 'none') return { topology, trustedProxies: undefined };
  if (topology === 'bundled') return { topology, trustedProxies: BUNDLED_PROXY_ADDRESS };

  const proxies = await input({
    message: 'Trusted proxy IPs/CIDRs (comma-separated):',
    default: existing === BUNDLED_PROXY_ADDRESS ? undefined : existing,
    validate: (value) =>
      value.trim() ? true : 'Enter the direct proxy IPs/CIDRs, or choose "None" instead.',
  });
  return { topology, trustedProxies: proxies.trim() };
}

const SKIP_MANUAL_RELATION = '\0none';

export const EMPTY_RELATION_FK_HINT =
  'No foreign keys point at this table/view. Photos stored in a child table have to be added here, or as a row-level images column.';

async function collectConfiguredRelation(options: {
  suggestion: RelationSuggestion;
  relTable: IntrospectedTable;
  selectedSchema: string;
  selectedTableName: string;
  idColumn: string;
  existingRelation: RelationConfig | undefined;
  existingRelationName: string | undefined;
  db: Awaited<ReturnType<typeof introspectDatabase>>['db'];
  usedPublishedNames: Set<string>;
}): Promise<{ name: string; relation: RelationConfig } | undefined> {
  const {
    suggestion,
    relTable,
    selectedSchema,
    selectedTableName,
    idColumn,
    existingRelation,
    existingRelationName,
    db,
    usedPublishedNames,
  } = options;

  const relationName =
    existingRelationName ?? `${suggestion.table}__${suggestion.foreignKeyColumn}`;

  // A type/kind/category-like column (e.g. Image.type) distinguishes
  // customer-facing gallery/featured photos from thumbnails, icons, and
  // invoices the same table can also store — detect it up front so it can
  // both be offered in the "expose" checkbox below and drive the filter
  // prompt further down.
  const typeColumn =
    suggestion.relationType === 'images' ? suggestImageTypeColumn(relTable.columns) : null;
  const selectableColumns = relTable.columns.filter((col) => {
    if (col.name === suggestion.foreignKeyColumn || col.isPrimaryKey) return false;
    // Only the URL field (via `imageUrlField`) and the type column (via
    // `filter`) ever influence a mapped item for an images relation —
    // every other column would be queried and then silently discarded,
    // which reads as "expose" without exposing anything (#27231).
    if (suggestion.relationType === 'images') {
      return /url$/i.test(col.name) || /^src$/i.test(col.name) || col.name === typeColumn;
    }
    // Same text/numeric/enum allowlist as row attributes — bytea/geometry
    // would ship as Buffer JSON inside a generic relation's attributes.
    return isAttributeEligibleColumn(col);
  });
  const defaultColumn =
    suggestion.relationType === 'images'
      ? selectableColumns.find((col) => /url$/i.test(col.name) || /^src$/i.test(col.name))
      : suggestion.relationType === 'features'
        ? selectableColumns.find(
            (col) => /name/i.test(col.name) || /value/i.test(col.name) || /label/i.test(col.name),
          )
        : undefined;
  if (selectableColumns.length === 0) {
    console.log(
      `\nNote: ${suggestion.table} has no eligible columns to expose. ` +
        'A blob/binary column cannot become images[] or a relation attribute.',
    );
    return undefined;
  }
  const selectedColumns = await checkbox({
    message: `Select columns from ${suggestion.table} to expose:`,
    choices: selectableColumns.map((col) => ({
      name: col.name,
      value: col.name,
      checked:
        Boolean(existingRelation?.fields[col.name]) ||
        col.name === defaultColumn?.name ||
        col.name === typeColumn,
    })),
  });
  const selectedColumnNames = new Set(selectedColumns);
  const fieldsMap: Record<string, string> = {};
  for (const col of selectableColumns) {
    if (!selectedColumnNames.has(col.name)) continue;
    fieldsMap[col.name] = quoteIfNeeded(col.name);
  }

  const relation: RelationConfig = {
    schema: selectedSchema,
    table: suggestion.table,
    foreignKey: quoteIfNeeded(suggestion.foreignKeyColumn),
    referenceKey: quoteIfNeeded(suggestion.toColumn ?? idColumn),
    fields: fieldsMap,
  };

  if (suggestion.relationType === 'images') {
    const urlCol = relTable.columns.find((c) => /url$/i.test(c.name) || /^src$/i.test(c.name));
    if (urlCol && selectedColumnNames.has(urlCol.name)) {
      relation['imageUrlField'] = urlCol.name;
    }

    const orderColumn = relTable.columns.find((col) =>
      /^(sort_?order|position|order|is_?primary)$/i.test(col.name),
    );
    if (orderColumn) {
      const defaultDirection = /^is_?primary$/i.test(orderColumn.name) ? 'desc' : 'asc';
      const useOrder = await confirm({
        message: `Order images by ${orderColumn.name}?`,
        default: Boolean(existingRelation?.orderBy),
      });
      if (useOrder) {
        relation['orderBy'] = {
          column: quoteIfNeeded(orderColumn.name),
          direction: defaultDirection,
        };
      }
    }

    // Offer a filter matching the README's `type = 'gallery' OR type =
    // 'featured'` shape when a type/kind/category column exists; `filter`
    // is a raw SQL predicate the relation query applies directly against
    // the source column (see queryRelation), independent of the `fields`
    // map above, so this runs whether or not the operator also chose to
    // carry the column into `fields`. Leave `filter` unset when there's
    // no such column (nothing to filter on).
    if (typeColumn) {
      const pkColumn = relTable.columns.find((col) => col.isPrimaryKey);
      const distinctTypeValues = await collectDistinctColumnValues(
        db,
        selectedSchema,
        suggestion.table,
        typeColumn,
        pkColumn?.name,
      );
      if (distinctTypeValues.length > 0) {
        const presentedValues = distinctTypeValues.slice(0, IMAGE_TYPE_VALUE_PROMPT_LIMIT);
        if (distinctTypeValues.length > presentedValues.length) {
          console.log(
            `\n"${typeColumn}" has more than ${IMAGE_TYPE_VALUE_PROMPT_LIMIT} distinct values. Offering the first ${presentedValues.length}; re-run setup after narrowing the column down if a customer-facing value is missing.`,
          );
        }
        const includedValues = await checkbox({
          message: `Which "${typeColumn}" values on ${suggestion.table} are customer-facing photos? (unchecked values — e.g. thumbnails, icons, invoices — are left out of images[])`,
          choices: presentedValues.map((value) => ({
            name: value,
            value,
            checked: existingRelation?.filter
              ? existingRelation.filter.includes(toConfigLiteral(value))
              : /gallery|featured|photo|primary|main|hero/i.test(value),
          })),
        });
        if (includedValues.length > 0) {
          relation['filter'] = includedValues
            .map((value) => `${quoteIfNeeded(typeColumn)} = ${toConfigLiteral(value)}`)
            .join(' OR ');
        }
      }
    }
  } else if (suggestion.relationType === 'features') {
    const nameCol = relTable.columns.find(
      (c) => /name/i.test(c.name) || /value/i.test(c.name) || /label/i.test(c.name),
    );
    if (nameCol && selectedColumnNames.has(nameCol.name)) {
      relation['flatten'] = nameCol.name;
      // Keep this explicit in generated config. Runtime also treats omitted
      // legacy values as enabled so upgraded connectors gain the behavior.
      relation['searchable'] = true;
    }
  }

  // The map key (`relationName`) stays the disambiguated `table__foreignKey`
  // key so two FKs onto the same child table can't collide (#26144). A
  // flatten/generic relation's runtime *output* attribute is published
  // under a separate, stable semantic name instead — the disambiguated
  // key is an internal collision guard, not a customer-facing name.
  if (suggestion.relationType === 'features' || suggestion.relationType === 'generic') {
    const basePublishedName =
      existingRelation?.publishAs ??
      derivePublishedRelationName(suggestion.table, selectedTableName);
    let publishedName = basePublishedName;
    for (let suffix = 2; usedPublishedNames.has(publishedName); suffix++) {
      publishedName = `${basePublishedName}_${suffix}`;
    }
    usedPublishedNames.add(publishedName);
    relation['publishAs'] = publishedName;
  }

  return { name: relationName, relation };
}

function printInventorySortIndexHint(
  schema: string,
  table: string,
  idColumn: string,
  updatedAtColumn: string | undefined,
): void {
  // GET /inventory and its /health sample sort `<sortColumn> DESC NULLS LAST, <idColumn> DESC`.
  // Only this composite index can serve that order; the read-only connector cannot create it,
  // so print the statement for the operator to run by hand.
  const sortIndexColumn = updatedAtColumn ?? idColumn;
  const sortIndexClause =
    sortIndexColumn === idColumn
      ? `${quoteIfNeeded(sortIndexColumn)} DESC NULLS LAST`
      : `${quoteIfNeeded(sortIndexColumn)} DESC NULLS LAST, ${quoteIfNeeded(idColumn)} DESC`;
  console.log(
    '   Create this index so GET /inventory can use it (the connector is read-only and ' +
      'cannot create it itself); without it, every inventory page sorts the whole table:',
  );
  console.log(
    `   CREATE INDEX CONCURRENTLY kasbly_connector_sort_idx ON ` +
      `${quoteIfNeeded(schema)}.${quoteIfNeeded(table)} (${sortIndexClause});`,
  );
  console.log('');
}
export async function runWizard(): Promise<void> {
  console.log('\n🔧 Kasbly Connector Setup\n');

  const configPath = resolve('connector.config.yml');
  const envPath = resolve('.env');
  const hasExistingConfig = existsSync(configPath);
  const hasExistingEnv = existsSync(envPath);
  if (hasExistingConfig || hasExistingEnv) {
    const overwriteExisting = await confirm({
      message:
        'Existing connector configuration was found. Continue and create timestamped backups before saving?',
      default: false,
    });
    if (!overwriteExisting) {
      console.log('Setup cancelled. Existing files were not changed.');
      return;
    }
  }

  let existingConfig: ConnectorConfig | undefined;
  if (hasExistingConfig) {
    try {
      existingConfig = loadExistingSetupConfig(configPath, envPath);
    } catch (error) {
      console.warn(
        `Could not read ${configPath} (${error instanceof Error ? error.message : String(error)}). ` +
          'Starting from defaults; your existing files are backed up before anything is written.',
      );
    }
  }
  const existingEnv = hasExistingEnv ? parse(readFileSync(envPath, 'utf-8')) : {};
  const existingApiKey = existingEnv['CONNECTOR_API_KEY']?.trim() || undefined;
  const existingPendingApiKey = existingEnv['CONNECTOR_API_KEY_PENDING']?.trim() || undefined;

  // Step 1: Database Connection
  console.log('Step 1: Database Connection');
  const dbType = await select({
    message: 'Database type:',
    choices: [{ name: 'PostgreSQL', value: 'postgres' as const }],
  });
  const dbHost = await input({
    message: 'Host:',
    default: getSetupHostDefault(existingConfig?.database.host),
  });
  const dbPort = await input({
    message: 'Port:',
    default: String(existingConfig?.database.port ?? 5432),
  });
  const dbName = await input({
    message: 'Database name:',
    default: existingConfig?.database.database,
  });
  const dbUser = await input({ message: 'Username:', default: existingConfig?.database.user });
  // Password prompts deliberately have no default. Reuse the validated existing
  // value on edits so a mapping-only change does not require re-entering it.
  const dbPassword =
    existingConfig?.database.password ??
    (await password({
      message: 'Password:',
      mask: true,
      // A password carrying both a single quote and a double quote or backslash
      // makes serializeEnvValue throw when the .env is written at the end of the
      // wizard — by then connector.config.yml may already be on disk with no
      // matching .env (#27786). Reject it here, before ~30 more prompts run.
      validate: (value) => {
        try {
          serializeEnvValue(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    }));
  const requiresTls = await confirm({
    message: 'Does this database require TLS?',
    default: existingConfig?.database.ssl ?? shouldDefaultToTls(dbHost),
  });
  const tls = await collectTlsSettings(requiresTls);
  const dbSchema = await input({
    message: 'PostgreSQL schema:',
    default: existingConfig?.resources.inventory.schema ?? 'public',
    validate: (value) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ||
      'Schema must be a PostgreSQL identifier (letters, numbers, and underscores).',
  });
  const selectedSchema = dbSchema?.trim() || 'public';

  console.log('\nConnecting...');
  const connection = await introspectDatabase({
    type: dbType,
    host: dbHost,
    port: parseInt(dbPort, 10),
    database: dbName,
    user: dbUser,
    password: dbPassword,
    ssl: tls.enabled,
    sslCa: tls.ca,
    sslRejectUnauthorized: tls.rejectUnauthorized,
    schema: selectedSchema,
  });
  const { db, result } = connection;
  if (connection.retriedWithTls) {
    tls.enabled = true;
    tls.rejectUnauthorized = true;
    console.log('Plaintext connection was rejected; retried with verified TLS.');
  }
  console.log(`✓ Connected! Found ${result.tables.length} tables or views.\n`);

  if (result.tables.length === 0) {
    await db.destroy();
    throw new Error(`No tables or views in schema ${selectedSchema} — pick another schema.`);
  }

  // Step 2: Select Inventory Table
  console.log('Step 2: Select Your Inventory Table');
  const tableChoices = result.tables
    .sort((a, b) => b.rowCount - a.rowCount)
    .map((t) => ({
      name: `${t.name} (${t.kind}, ${t.rowCount.toLocaleString()} rows)`,
      value: t.name,
    }));

  const selectedTableName = await select({
    message: 'Which table contains your products/inventory?',
    choices: tableChoices,
    default: tableChoices.some(
      (choice) => choice.value === existingConfig?.resources.inventory.table,
    )
      ? existingConfig?.resources.inventory.table
      : undefined,
  });

  const selectedTable = result.tables.find((t) => t.name === selectedTableName)!;

  if (selectedTable.columns.length === 0) {
    console.error(
      `Cannot save configuration: this ${selectedTable.kind} has no readable columns — grant SELECT or pick another object.`,
    );
    await db.destroy();
    return;
  }

  // Step 3: Field Mapping
  console.log('\nStep 3: Field Mapping');
  const suggestions = suggestFieldMappings(selectedTable.columns);
  const suggestedAttributes = new Map(
    suggestions
      .filter((suggestion) => suggestion.mappingType === 'attribute')
      .map((suggestion) => [suggestion.columnName, suggestion.suggestedMapping]),
  );
  const existingInventory = existingConfig?.resources.inventory;
  const suggestedId =
    getExistingMappingSelection(
      existingInventory?.idColumn,
      selectedTable.columns.map((column) => column.name),
    ) ?? suggestIdColumn(selectedTable.columns);
  const idPrompt = getIdColumnPrompt(selectedTable.columns, suggestedId);
  const idColumn = await select(idPrompt);
  if (!selectedTable.columns.some((column) => column.name === idColumn)) {
    console.error(
      `Cannot save configuration: unique listing id "${idColumn}" is not a column on this ${selectedTable.kind}.`,
    );
    await db.destroy();
    return;
  }
  const suggestedUpdatedAt =
    getExistingMappingSelection(
      existingInventory?.updatedAtColumn,
      selectedTable.columns.map((column) => column.name),
    ) ?? suggestUpdatedAtColumn(selectedTable.columns);
  const selectedUpdatedAt = await select(
    getUpdatedAtColumnPrompt(selectedTable.columns, suggestedUpdatedAt),
  );
  const updatedAtColumn =
    selectedUpdatedAt === UNMAPPED_FIELD_VALUE ? undefined : selectedUpdatedAt;
  const allColumnNames = selectedTable.columns.map((c) => c.name);

  const fieldMappings: Partial<Record<FieldMappingTarget, string>> = {};
  let statusValues: StatusValuesConfig | undefined;
  let unknownStatusPolicy: UnknownStatusPolicy | undefined;
  const mappedColumnNames = new Set<string>();
  for (const field of FIELD_MAPPING_TARGETS) {
    const suggestedColumn = suggestions.find(
      (suggestion) => suggestion.mappingType === 'field' && suggestion.suggestedMapping === field,
    )?.columnName;
    const existingMapping = existingConfig?.resources.inventory.fields[field];
    const existingSelection = getExistingMappingSelection(existingMapping, allColumnNames);
    const prompt = getFieldMappingPrompt(
      field,
      selectedTable.columns,
      existingSelection ?? suggestedColumn,
      !existingSelection && existingMapping?.startsWith("'") === true,
    );
    const selectedValue = await select(prompt);

    if (selectedValue === UNMAPPED_FIELD_VALUE) {
      // No config key records "there is no status column", so the one chance the
      // operator gets to learn what an unmapped status means is right here.
      if (field === 'status') {
        console.log(
          `\nNo status column mapped: every listing will be reported as ${UNMAPPED_STATUS_FALLBACK}. ` +
            'Map a status column if some listings are not available.',
        );
      }
      continue;
    }
    if (selectedValue === FIXED_VALUE_FIELD_VALUE) {
      const fixedValue =
        field === 'status'
          ? await select<InventoryStatus>({
              message: 'Fixed Kasbly status for every row:',
              choices: INVENTORY_STATUSES.map((status) => ({ name: status, value: status })),
              default: getFixedConfigValue(existingMapping) as InventoryStatus | undefined,
            })
          : await input({
              message: `Fixed ${field} value for every row:`,
              default: getFixedConfigValue(existingMapping),
              validate: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return 'A fixed value is required.';
                if (trimmed.includes("'")) return 'Fixed values cannot contain single quotes.';
                return true;
              },
            });
      fieldMappings[field] = toConfigLiteral(fixedValue.trim());
      continue;
    }

    fieldMappings[field] = quoteIfNeeded(selectedValue);
    mappedColumnNames.add(selectedValue);
    if (field === 'status') {
      const collected = await collectStatusValues(
        db,
        selectedSchema,
        selectedTableName,
        selectedValue,
        idColumn,
        updatedAtColumn,
        existingInventory?.statusValues,
      );
      // Every value left unmapped means there is nothing to write; omitting the key
      // keeps the generated config free of an empty block that reads as a mapping.
      statusValues = Object.keys(collected).length > 0 ? collected : undefined;
      unknownStatusPolicy = await select<UnknownStatusPolicy>({
        message: 'How should newly observed source statuses be exposed until you map them?',
        choices: ['DRAFT', 'RESERVED', 'SOLD', 'EXPIRED'].map((status) => ({
          name: status,
          value: status as UnknownStatusPolicy,
        })),
        default: existingInventory?.unknownStatusPolicy ?? 'DRAFT',
      });
    }
  }

  const missingRequiredMappings = ['title', 'price', 'currency'].filter(
    (field) => !fieldMappings[field as FieldMappingTarget],
  );
  if (missingRequiredMappings.length > 0) {
    console.error(
      `Cannot save configuration: map ${missingRequiredMappings.join(' and ')} before continuing.`,
    );
    await db.destroy();
    return;
  }

  // Step 3a: Listing URL
  // A per-row customer-facing listing page, published as `attributes.url` —
  // the key `resolvePublicListingUrl` reads first (packages/shared's
  // listing-url.ts). This gets its own prompt, next to the images mapping
  // above, instead of only being reachable through the generic "additional
  // attributes" checkbox below: a `permalink`/`href`-shaped column is
  // otherwise just another easy-to-miss unchecked extra column, and every
  // default AI card ends with a dead 🔗 after a green Test connection
  // (#25311, #28246).
  console.log('\nStep 3a: Listing URL');
  const suggestedListingUrlColumn = suggestions.find(
    (suggestion) => suggestion.mappingType === 'attribute' && suggestion.suggestedMapping === 'url',
  )?.columnName;
  const existingListingUrlColumn = getExistingMappingSelection(
    existingConfig?.resources.inventory.attributes?.['url'],
    allColumnNames,
  );
  const listingUrlCandidates = allColumnNames.filter(
    (name) => !mappedColumnNames.has(name) && name !== idColumn && name !== updatedAtColumn,
  );
  let listingUrlColumn: string | undefined;
  // Always ask, even with zero remaining candidates (every column already
  // claimed by a field/id/updatedAt mapping) — mirrors getUpdatedAtColumnPrompt's
  // always-shown "Do not map" choice below rather than silently disappearing,
  // so the operator always gets the explicit "or set a template in Kasbly"
  // reminder instead of only the generic column list further down.
  {
    const defaultListingUrlColumn = existingListingUrlColumn ?? suggestedListingUrlColumn;
    const selectedListingUrl = await select({
      message:
        'Which column is the per-row customer-facing listing page (permalink / href / canonical ' +
        'URL)? Skip this only if you will set a listing URL template on this source in Kasbly instead.',
      choices: [
        {
          name: 'Skip — rely on a Kasbly-side listing URL template',
          value: UNMAPPED_FIELD_VALUE,
        },
        ...listingUrlCandidates.map((name) => ({
          name: name === defaultListingUrlColumn ? `${name} (suggested)` : name,
          value: name,
        })),
      ],
      default:
        defaultListingUrlColumn && listingUrlCandidates.includes(defaultListingUrlColumn)
          ? defaultListingUrlColumn
          : UNMAPPED_FIELD_VALUE,
    });
    if (selectedListingUrl !== UNMAPPED_FIELD_VALUE) {
      listingUrlColumn = selectedListingUrl;
      mappedColumnNames.add(selectedListingUrl);
    }
  }

  // Let user select which remaining columns to include as attributes. Columns
  // whose SQL type cannot round-trip as a plain attribute value (bytea,
  // tsvector, geometry, and arrays of those, etc.) are excluded up front —
  // node-postgres hands those back as Buffers or other opaque values that
  // JSON.stringify mangles into `{"type":"Buffer","data":[...]}` on the wire
  // (#28247) — the same text/numeric/enum allowlist filterable columns use.
  const unmappedColumns = selectedTable.columns.filter(
    (column) =>
      !mappedColumnNames.has(column.name) &&
      column.name !== idColumn &&
      column.name !== updatedAtColumn &&
      !/Id$/.test(column.name) &&
      !/_id$/.test(column.name) &&
      !/At$/.test(column.name) &&
      !/_at$/.test(column.name) &&
      isAttributeEligibleColumn(column),
  );

  const unsupportedTagColumns = selectedTable.columns.filter((column) => {
    const normalizedType = column.type.trim().toLowerCase();
    return (
      /(?:tag|feature)/i.test(column.name) &&
      (normalizedType === 'array' || normalizedType === 'json' || normalizedType === 'jsonb')
    );
  });
  if (unsupportedTagColumns.length > 0) {
    console.log(
      `Note: ${unsupportedTagColumns.map((column) => `"${column.name}"`).join(', ')} ` +
        'is JSON/array data and cannot be published or searched as a plain attribute. ' +
        'If it contains customer-facing tags, add a flattened relation in Step 5 instead.',
    );
  }

  let additionalAttributes: string[] = [];
  if (unmappedColumns.length > 0) {
    additionalAttributes = await checkbox({
      message: 'Select additional columns to include as attributes:',
      // The type is shown in the label so a borderline column (e.g. an enum)
      // is self-documenting, and so an operator never mistakes a truncated
      // choice for a URL — see getFieldMappingPrompt's images choices.
      choices: unmappedColumns.map((column) => ({
        name: `${column.name} (${column.type})`,
        value: column.name,
        checked:
          suggestedAttributes.has(column.name) ||
          Boolean(existingConfig?.resources.inventory.attributes?.[column.name]) ||
          Boolean(
            existingConfig?.resources.inventory.attributes?.[
              suggestedAttributes.get(column.name) ?? ''
            ],
          ),
      })),
    });
  }

  // Step 3b: Searchable Columns
  console.log('\nStep 3b: Search Configuration');
  const searchSuggestions = suggestSearchableColumns(selectedTable.columns);
  const suggestedSearchNames = new Set(searchSuggestions.map((s) => s.columnName));
  const allTextColumns = selectedTable.columns
    .filter(isTextColumn)
    .filter((column) => !column.isPrimaryKey || suggestedSearchNames.has(column.name))
    .map((c) => c.name);
  const mappedTitleColumn = selectedTable.columns.find(
    (column) => isTextColumn(column) && quoteIfNeeded(column.name) === fieldMappings.title,
  )?.name;

  const mappedCategoryColumn = selectedTable.columns.find(
    (column) => isTextColumn(column) && quoteIfNeeded(column.name) === fieldMappings.category,
  )?.name;

  let searchableColumns: string[] = [];
  if (allTextColumns.length > 0) {
    searchableColumns = await checkbox({
      message: 'Which columns should be searchable? (full-text search)',
      choices: allTextColumns.map((name) => ({
        name,
        value: name,
        checked: getSearchableColumnDefault(
          name,
          quoteIfNeeded(name),
          existingConfig?.resources.inventory.searchableColumns,
          suggestedSearchNames.has(name) ||
            name === mappedTitleColumn ||
            name === mappedCategoryColumn ||
            additionalAttributes.includes(name),
        ),
      })),
    });
  }
  if (searchableColumns.length === 0) {
    console.log(
      'Warning: No searchable columns are configured. Free-text inventory searches will be reported as unsupported.',
    );
  }

  // Step 3c: Filterable Columns
  console.log('\nStep 3c: Filter Configuration');
  const filterSuggestions = suggestFilterableColumns(
    selectedTable.columns,
    [
      ...suggestions.filter((suggestion) => suggestion.mappingType === 'attribute'),
      ...Object.entries(fieldMappings)
        .filter(([, columnExpr]) => !columnExpr.startsWith("'"))
        .map(([suggestedMapping, columnExpr]) => ({
          columnName: columnExpr.slice(1, -1).replaceAll('""', '"'),
          suggestedMapping,
          confidence: 'high' as const,
          mappingType: 'field' as const,
        })),
    ],
    additionalAttributes,
  );

  let selectedFilters: FilterableColumnSuggestion[] = [];
  if (filterSuggestions.length > 0) {
    const filterChoiceNames = await checkbox({
      message: 'Which filters should be available? (exact match or range)',
      choices: filterSuggestions.map((f) => ({
        name: `${f.filterName} (${f.columnName}, ${f.filterType})`,
        value: f.filterName,
        checked:
          (f.filterName === 'status' && Boolean(fieldMappings.status)) ||
          (existingConfig
            ? Boolean(existingConfig.resources.inventory.filterableColumns?.[f.filterName])
            : true),
      })),
    });
    const selectedNames = new Set(filterChoiceNames);
    selectedFilters = filterSuggestions.filter((f) => selectedNames.has(f.filterName));
  }

  // Step 4: Filters
  console.log('\nStep 4: Filters');
  const publishedColumn = suggestPublishedColumn(selectedTable.columns);
  const inStockFilter = suggestInStockFilter(selectedTable.columns);
  const softDeleteColumn = suggestSoftDeleteColumn(selectedTable.columns);

  let baseFilterParts: string[] = [];

  if (publishedColumn) {
    const usePublished = await confirm({
      message: `Only expose published items? (detected column: ${publishedColumn})`,
      default:
        existingConfig?.resources.inventory.baseFilter?.includes(
          `${quoteIfNeeded(publishedColumn)} = true`,
        ) ?? true,
    });
    if (usePublished) {
      baseFilterParts.push(`${quoteIfNeeded(publishedColumn)} = true`);
    }
  }

  if (inStockFilter) {
    const stockFilterExpression = inStockFilter.expression.replace(
      inStockFilter.column,
      quoteIfNeeded(inStockFilter.column),
    );
    const exposeInStock = await confirm({
      message: `Only expose in-stock items? (detected column: ${inStockFilter.column})`,
      default: getInStockFilterDefault(
        existingConfig?.resources.inventory.baseFilter,
        quoteIfNeeded(inStockFilter.column),
        stockFilterExpression,
      ),
    });
    if (exposeInStock) {
      baseFilterParts.push(stockFilterExpression);
    }
  }

  if (softDeleteColumn) {
    const excludeDeleted = await confirm({
      message: `Exclude soft-deleted items? (detected column: ${softDeleteColumn})`,
      default:
        existingConfig?.resources.inventory.baseFilter?.includes(
          `${quoteIfNeeded(softDeleteColumn)} IS NULL`,
        ) ?? true,
    });
    if (excludeDeleted) {
      baseFilterParts.push(`${quoteIfNeeded(softDeleteColumn)} IS NULL`);
    }
  }

  // Step 5: Relations
  console.log('\nStep 5: Related Tables');
  const relationSuggestions = suggestRelations(
    selectedTableName,
    result.tables,
    result.foreignKeys,
  );
  const relations: Record<string, RelationConfig> = {};
  // Tracks published (customer-facing) attribute names already used this run,
  // so a second flatten/generic relation that derives the same semantic name
  // (e.g. two child tables both nicknamed "features") gets a `_2` suffix
  // instead of silently overwriting the first relation's attribute.
  const usedPublishedNames = new Set<string>();
  const suggestedRelationTables = new Set(
    relationSuggestions.map((suggestion) => suggestion.table),
  );

  for (const suggestion of relationSuggestions) {
    const relTable = result.tables.find((t) => t.name === suggestion.table);
    if (!relTable) continue;

    // Relation names are also the keys used to load relation rows at runtime. Keep
    // a matching existing key when rerunning setup, but default new relations to a
    // table+foreignKey key so accepting more than one relation — including two FKs
    // from the same child table (#26144) — cannot overwrite a previous one.
    const existingRelationEntry = Object.entries(
      existingConfig?.resources.inventory.relations ?? {},
    ).find(
      ([, relation]) =>
        relation.table === suggestion.table &&
        unquoteIdentifier(relation.foreignKey) === suggestion.foreignKeyColumn,
    );

    const addRelation = await confirm({
      message: `Add relation: ${suggestion.table} (${suggestion.relationType}, FK: ${suggestion.foreignKeyColumn})?`,
      default: Boolean(existingRelationEntry) || suggestion.confidence !== 'low',
    });

    if (addRelation) {
      const configured = await collectConfiguredRelation({
        suggestion,
        relTable,
        selectedSchema,
        selectedTableName,
        idColumn,
        existingRelation: existingRelationEntry?.[1],
        existingRelationName: existingRelationEntry?.[0],
        db,
        usedPublishedNames,
      });
      if (configured) relations[configured.name] = configured.relation;
    }
  }

  // Views cannot be FOREIGN KEY targets, and unconstrained child tables never
  // appear in suggestRelations — offer a manual table/join picker so photos
  // stored that way can still be written as the same `relations:` shape.
  if (relationSuggestions.length === 0) {
    console.log(EMPTY_RELATION_FK_HINT);
  }

  let offerManualPicker = relationSuggestions.length === 0;
  while (true) {
    const addedTables = new Set(Object.values(relations).map((relation) => relation.table));
    const remainingTables = result.tables.filter(
      (table) =>
        table.name !== selectedTableName &&
        table.columns.length > 0 &&
        !addedTables.has(table.name) &&
        !suggestedRelationTables.has(table.name),
    );
    if (remainingTables.length === 0) break;

    if (!offerManualPicker) {
      const addManual = await confirm({
        message: 'Add a related table or view that has no foreign key?',
        default: false,
      });
      if (!addManual) break;
    }
    offerManualPicker = false;

    const imageLike = remainingTables.find((table) => classifyRelationType(table) === 'images');
    const tableName = await select({
      message: 'Which table or view holds related rows (for example photos)?',
      choices: [
        { name: 'None — continue without a related table', value: SKIP_MANUAL_RELATION },
        ...remainingTables
          .slice()
          .sort((a, b) => b.rowCount - a.rowCount)
          .map((table) => ({
            name: `${table.name} (${table.kind}, ${table.rowCount.toLocaleString()} rows)`,
            value: table.name,
          })),
      ],
      default: imageLike?.name ?? SKIP_MANUAL_RELATION,
    });
    if (tableName === SKIP_MANUAL_RELATION) break;

    const relTable = remainingTables.find((table) => table.name === tableName);
    if (!relTable) break;

    const suggestedFk = suggestJoinColumn(selectedTableName, idColumn, relTable.columns);
    const foreignKeyColumn = await select({
      message: `Which column on ${tableName} joins to ${selectedTableName}?`,
      choices: relTable.columns.map((column) => ({
        name: column.name === suggestedFk ? `${column.name} (suggested)` : column.name,
        value: column.name,
      })),
      ...(suggestedFk ? { default: suggestedFk } : {}),
    });

    const suggestion: RelationSuggestion = {
      table: tableName,
      foreignKeyColumn,
      toColumn: idColumn,
      relationType: classifyRelationType(relTable),
      confidence: 'low',
    };
    const existingRelationEntry = Object.entries(
      existingConfig?.resources.inventory.relations ?? {},
    ).find(
      ([, relation]) =>
        relation.table === suggestion.table &&
        unquoteIdentifier(relation.foreignKey) === suggestion.foreignKeyColumn,
    );
    const configured = await collectConfiguredRelation({
      suggestion,
      relTable,
      selectedSchema,
      selectedTableName,
      idColumn,
      existingRelation: existingRelationEntry?.[1],
      existingRelationName: existingRelationEntry?.[0],
      db,
      usedPublishedNames,
    });
    if (configured) relations[configured.name] = configured.relation;
  }

  // A blob/bytea column can never become images[] (#28247) — if the operator
  // left the images field unmapped and never configured an images relation
  // either, point them at what would actually work instead of shipping a
  // catalog with no photos.
  const hasImagesRelation = Object.values(relations).some((relation) =>
    Boolean(relation.imageUrlField),
  );
  if (!fieldMappings.images && !hasImagesRelation) {
    console.log(
      '\nNote: no images source configured. A blob/binary column cannot become images[] — ' +
        'map a URL, PostgreSQL text array, or JSON array column to "images" in Step 3, or add a ' +
        'child table of photo rows as an images relation here.',
    );
  }

  // Step 6: Security
  console.log('\nStep 6: Security');
  let currentApiKey: string;
  let pendingApiKey: string | undefined = existingPendingApiKey;
  let retirePreviousKey = false;

  if (existingApiKey && existingPendingApiKey) {
    retirePreviousKey = await confirm({
      message:
        'Retire the previous API key? Do this only after Kasbly has tested and switched to the staged key.',
      default: false,
    });
    currentApiKey = retirePreviousKey ? existingPendingApiKey : existingApiKey;
    if (retirePreviousKey) {
      pendingApiKey = undefined;
      console.log(
        '✓ Retired the previous API key. The connector will accept only the current key.',
      );
    } else {
      console.log(
        '✓ Rotation remains staged. The connector accepts both current and pending keys.',
      );
    }
  } else {
    const generateKey = await confirm(
      existingApiKey
        ? {
            message: 'Generate and stage a replacement API key for zero-downtime rotation?',
            default: false,
          }
        : { message: 'Generate API key?', default: true },
    );
    const generatedOrEnteredKey = generateKey
      ? `kc_${randomBytes(24).toString('hex')}`
      : (existingApiKey ??
        (
          await input({
            message: 'Enter your API key:',
            validate: (value) => (value.trim() ? true : 'Enter a non-empty API key.'),
          })
        ).trim());

    currentApiKey = existingApiKey ?? generatedOrEnteredKey;
    if (existingApiKey && generateKey) pendingApiKey = generatedOrEnteredKey;
  }

  // The reverse-proxy topology decides whether the wizard's final "next
  // steps" run the bundled Compose deployment (`docker compose up -d`) or
  // tell the operator to bind :4000 themselves, so it has to be known before
  // asking for a public DNS name. Only the bundled Caddy proxy needs one —
  // `docker compose up -d` refuses to resolve without CONNECTOR_DOMAIN, and
  // without trustedProxies every request behind it is attributed to Caddy's
  // internal address — so `custom`/`none` skip the prompt entirely rather
  // than demanding a domain the printed instructions never use.
  const { topology: proxyTopology, trustedProxies } = await collectTrustedProxies(
    existingConfig?.server.trustedProxies,
  );
  const connectorDomain =
    proxyTopology === 'bundled'
      ? (
          await input({
            message:
              'Public DNS name for this connector (its A/AAAA record must point at this host):',
            default: existingEnv['CONNECTOR_DOMAIN'],
            validate: (value) =>
              isPublicHostname(value) ||
              'Enter a DNS name such as connector.merchant.example — no scheme, port, or path.',
          })
        ).trim()
      : undefined;

  // Build config object
  // Everything below is selected by this wizard, so rebuild it instead of
  // overlaying selections onto the previous inventory mapping. This makes an
  // explicit "No" or an empty checkbox selection remove stale configuration.
  const fields: Record<string, string> = {};
  const attributes: Record<string, string> = {};

  fields['externalId'] = quoteIfNeeded(idColumn);
  Object.assign(fields, fieldMappings);
  if (listingUrlColumn) {
    attributes['url'] = quoteIfNeeded(listingUrlColumn);
  }
  for (const attrName of additionalAttributes) {
    // suggestedAttributes only has one entry per target: suggestFieldMappings
    // stops at the first matching column, so a second URL-shaped column
    // manually checked here (e.g. `permalink` alongside an already-suggested
    // `url`) has no entry there and would otherwise publish under its own raw
    // column name instead of the canonical `attributes.url` key that
    // `resolvePublicListingUrl` reads (#28246).
    const target =
      suggestedAttributes.get(attrName) ?? (isListingUrlColumn(attrName) ? 'url' : attrName);
    attributes[target] = quoteIfNeeded(attrName);
  }

  // Carry forward an existing attributes key only when no column in this
  // run's schema even offers it as a checkbox candidate. `additionalAttributes`
  // already lets the merchant deselect any suggested attribute (including a
  // pattern-matched make/year/model column, or an unsuggested column checked
  // under its own name, e.g. `legacy_attribute`) and have that removal
  // honoured — that's a deliberate, tested rerun behaviour, not a bug. The
  // actual gap (#28985) is narrower: a hand-edited `attributes.year` pointed
  // at a column whose name doesn't itself look year-shaped is never a
  // suggestion for *any* column this run (that column would instead publish
  // under its own name if checked), so `year` never appears in the checkbox
  // as an achievable outcome and had no way to be reselected — that's the
  // only case worth preserving. `url` is excluded: Step 3a always asks
  // explicitly, so an unpicked url this run is deliberate too.
  const reachableAttributeTargets = new Set(
    unmappedColumns.map(
      (column) =>
        suggestedAttributes.get(column.name) ??
        (isListingUrlColumn(column.name) ? 'url' : column.name),
    ),
  );
  for (const [key, column] of Object.entries(
    existingConfig?.resources.inventory.attributes ?? {},
  )) {
    if (key === 'url' || key in attributes || reachableAttributeTargets.has(key)) continue;
    attributes[key] = column;
  }

  // A rerun rebuilds filterableColumns purely from this run's suggestions —
  // right for anything the merchant was actually asked about this run (an
  // explicit uncheck/skip should indeed remove it, per the "Build config
  // object" comment below — including a filter whose underlying attribute was
  // itself deselected in Step 3a). But a hand-added filterableColumns entry
  // using a key the suggestion heuristics could never derive from *any*
  // column this run, checked or not, had no checkbox to reconfirm it, so a
  // rerun used to silently delete it even though nothing this run ever gave
  // the merchant a chance to remove it (#28985). `maxFilterSuggestions`
  // reruns the same heuristic as if every candidate column were checked,
  // purely to answer "could this key ever appear this run" — it never drives
  // what's actually written below.
  const maxFilterSuggestions = suggestFilterableColumns(
    selectedTable.columns,
    [
      ...suggestions.filter((suggestion) => suggestion.mappingType === 'attribute'),
      ...Object.entries(fieldMappings)
        .filter(([, columnExpr]) => !columnExpr.startsWith("'"))
        .map(([suggestedMapping, columnExpr]) => ({
          columnName: columnExpr.slice(1, -1).replaceAll('""', '"'),
          suggestedMapping,
          confidence: 'high' as const,
          mappingType: 'field' as const,
        })),
    ],
    unmappedColumns.map((column) => column.name),
  );
  const filterableColumnsFromSelection = Object.fromEntries(
    selectedFilters.map((f) => [
      f.filterName,
      { column: quoteIfNeeded(f.columnName), type: f.filterType },
    ]),
  );
  const carriedForwardFilterableColumns = Object.fromEntries(
    Object.entries(existingConfig?.resources.inventory.filterableColumns ?? {}).filter(
      ([key]) => !maxFilterSuggestions.some((f) => f.filterName === key),
    ),
  );
  const filterableColumns = {
    ...carriedForwardFilterableColumns,
    ...filterableColumnsFromSelection,
  };

  const hasListingUrlAttribute = ['url', 'listingUrl', 'listing_url', 'link', 'handle'].some(
    (key) => Boolean(attributes[key]),
  );
  // WordPress and Magento commonly store public image and permalink paths
  // relative to the site origin. Ask whenever either mapping needs resolving.
  let imageUrlPrefix = existingInventory?.imageUrlPrefix;
  if (fieldMappings.images || hasImagesRelation || hasListingUrlAttribute) {
    console.log('\nStep 6a: Public URL origin');
    const configuredPrefix = await input({
      message:
        'Public site origin for relative image or listing paths (for example https://shop.example.com). Leave blank when URLs are already absolute:',
      default: imageUrlPrefix,
      validate: (value) => {
        const origin = value.trim();
        return (
          !origin ||
          isPublicImageUrlOrigin(origin) ||
          'Enter an absolute http(s) origin without a path, query, or fragment.'
        );
      },
    });
    // Inquirer only returns strings after validation; retain this guard for
    // non-interactive callers that bypass a prompt's validator.
    const origin = typeof configuredPrefix === 'string' ? configuredPrefix.trim() : '';
    imageUrlPrefix = isPublicImageUrlOrigin(origin) ? origin : undefined;
  }

  const config = {
    ...existingConfig,
    version: existingConfig?.version ?? 1,
    server: {
      port: existingConfig?.server.port ?? 4000,
      host: existingConfig?.server.host ?? '0.0.0.0',
      // Rebuilt rather than passed through, so choosing "None" this run also
      // drops a trustedProxies value a previous run wrote.
      ...(trustedProxies ? { trustedProxies } : {}),
    },
    auth: {
      apiKeys: [
        { key: '${CONNECTOR_API_KEY}', label: 'kasbly-current' },
        ...(pendingApiKey
          ? [{ key: '${CONNECTOR_API_KEY_PENDING}', label: 'kasbly-pending' }]
          : []),
      ],
    },
    database: {
      type: dbType,
      host: '${DB_HOST}',
      port: parseInt(dbPort, 10),
      database: '${DB_NAME}',
      user: '${DB_USER}',
      password: '${DB_PASSWORD}',
      ssl: tls.enabled,
      ...(tls.ca ? { sslCa: '${DB_SSL_CA}' } : {}),
      ...(tls.enabled && !tls.rejectUnauthorized ? { sslRejectUnauthorized: false } : {}),
      statementTimeoutMs: existingConfig?.database.statementTimeoutMs ?? 10000,
      pool: existingConfig?.database.pool ?? { min: 2, max: 10 },
    },
    rateLimit: existingConfig?.rateLimit ?? { maxRequests: 100, windowSeconds: 60 },
    audit: existingConfig?.audit ?? {
      enabled: true,
      filePath: './logs/audit.log',
      maxFileSizeMB: 50,
      maxFiles: 10,
      retentionDays: 90,
    },
    resources: {
      ...existingConfig?.resources,
      inventory: {
        schema: selectedSchema,
        table: selectedTableName,
        ...(baseFilterParts.length > 0 ? { baseFilter: baseFilterParts.join(' AND ') } : {}),
        idColumn: quoteIfNeeded(idColumn),
        ...(updatedAtColumn ? { updatedAtColumn: quoteIfNeeded(updatedAtColumn) } : {}),
        ...(imageUrlPrefix ? { imageUrlPrefix } : {}),
        fields,
        ...(statusValues ? { statusValues } : {}),
        ...(unknownStatusPolicy ? { unknownStatusPolicy } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(searchableColumns.length > 0
          ? { searchableColumns: searchableColumns.map(quoteIfNeeded) }
          : {}),
        ...(Object.keys(filterableColumns).length > 0 ? { filterableColumns } : {}),
        ...(Object.keys(relations).length > 0 ? { relations } : {}),
      },
    },
  };

  const configuredRelations = Object.entries(relations);
  if (configuredRelations.length > 0) {
    console.log('\nRelation columns to expose:');
    for (const [relationName, relationConfig] of configuredRelations) {
      const relationFields = (relationConfig as { fields: Record<string, string> }).fields;
      const columnNames = Object.keys(relationFields);
      console.log(
        `  ${relationName} (${relationConfig.table}): ${columnNames.length > 0 ? columnNames.join(', ') : '(none)'}`,
      );
    }
  }

  if (existingInventory) {
    console.log(
      `\nInventory mapping changes:\n${formatInventoryDiff(existingInventory, config.resources.inventory)}`,
    );
  }

  // Validate through the same adapter and probe that `/health`, `validate`, and
  // Kasbly's Test connection use. This keeps setup's sample row, filtering,
  // ordering, relation reads, and wire-contract validation in lockstep.
  const validationAdapter = createDatabaseAdapter({
    ...config.database,
    host: dbHost,
    database: dbName,
    user: dbUser,
    password: dbPassword,
    ...(tls.ca ? { sslCa: tls.ca } : {}),
  });
  try {
    await validationAdapter.connect();
    const {
      unknownStatusValues,
      wireContractViolationIds,
      unservableImageIds,
      unservableListingUrlIds,
    } = await probeInventoryResource(validationAdapter, config.resources.inventory);
    // Mirrors `npm run validate` (cli.ts): an unmapped source status is silently
    // reported as unknownStatusPolicy and withheld from customers, so the
    // operator must be told before the config is saved, not just at the next
    // `/health` check (#26873).
    const statusWarning = formatUnknownStatusWarning(unknownStatusValues, unknownStatusPolicy);
    if (statusWarning) console.warn(`Warning: ${statusWarning}`);
    const warning = formatWireContractViolationWarning(wireContractViolationIds);
    if (warning) console.warn(`Warning: ${warning}`);
    const imageWarning = formatUnservableImageWarning(unservableImageIds);
    if (imageWarning) console.warn(`Warning: ${imageWarning}`);
    const listingUrlWarning = formatUnservableListingUrlWarning(unservableListingUrlIds);
    if (listingUrlWarning) console.warn(`Warning: ${listingUrlWarning}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isWireContractFailure = message.startsWith(
      'Inventory resource probe failed for sample row:',
    );
    console.error(
      `Cannot save configuration: ${
        isWireContractFailure
          ? 'inventory sample violates the wire contract'
          : 'inventory probe failed'
      }: ${message}`,
    );
    // The contextual error preserves its transient database code, so show the sort-index remedy before exit.
    if (isTransientProbeError(error)) {
      printInventorySortIndexHint(selectedSchema, selectedTableName, idColumn, updatedAtColumn);
    }
    await db.destroy();
    throw error;
  } finally {
    await validationAdapter.disconnect();
  }

  // js-yaml v5 replaced `quotingType: '"'` with `quoteStyle: 'double'`.
  const yamlContent = yaml.dump(config, { lineWidth: 120, quoteStyle: 'double' });
  // The wizard and `npm run validate` run on the host, while Compose runs the
  // connector in a container. Keep the host address in .env and let Compose
  // use its container-only override for loopback databases (#28984).
  const bundledLoopbackDbTrap = proxyTopology === 'bundled' && isLoopbackHost(dbHost);
  // Build the .env content BEFORE writing connector.config.yml. mergeEnvironmentFile
  // (via serializeEnvValue) can still throw here for a rerun that reuses an
  // existingConfig password never run through the prompt's own validate — building
  // it first means that throw happens before either file is touched, instead of
  // after connector.config.yml is already saved with no matching .env (#27786).
  const envContent = mergeEnvironmentFile(hasExistingEnv ? readFileSync(envPath, 'utf-8') : '', {
    DB_HOST: dbHost,
    DB_NAME: dbName,
    DB_USER: dbUser,
    DB_PASSWORD: dbPassword,
    ...(tls.ca ? { DB_SSL_CA: tls.ca } : {}),
    CONNECTOR_API_KEY: currentApiKey,
    CONNECTOR_API_KEY_PENDING: pendingApiKey ?? null,
    // Rebuilt rather than passed through, so switching away from the bundled
    // proxy on a rerun also drops a CONNECTOR_DOMAIN value a previous run
    // wrote — `custom`/`none` never use it.
    CONNECTOR_DOMAIN: connectorDomain ?? null,
    // docker-compose.yml publishes the connector's port on CONNECTOR_BIND
    // (default 127.0.0.1). `none` has no reverse proxy in front of it at
    // all, so it is the one topology that needs the connector reachable
    // from the network; `bundled`/`custom` both put a proxy on this host
    // (Caddy, or the operator's own), so they drop back to the loopback
    // default rather than writing a value (#27785).
    CONNECTOR_BIND: proxyTopology === 'none' ? '0.0.0.0' : null,
    // docker-compose.yml applies this only inside the connector container;
    // retain DB_HOST for host-side setup and validation commands.
    CONNECTOR_CONTAINER_DB_HOST: bundledLoopbackDbTrap ? 'host.docker.internal' : null,
  });
  // The inventory probe uses a directly constructed adapter, so it never
  // parses auth with the entered secret. Refuse to write if loadConfig would
  // reject the interpolated result (for example CONNECTOR_API_KEY='').
  try {
    validateProspectiveConfig(yamlContent, envContent);
  } catch (error) {
    console.error(
      `Cannot save configuration: generated config is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await db.destroy();
    return;
  }
  if (hasExistingConfig) backupPrivateFile(configPath);
  if (hasExistingEnv) backupPrivateFile(envPath);
  writePrivateFile(configPath, yamlContent);
  console.log(`✅ Configuration saved to ${configPath}`);
  writePrivateFile(envPath, envContent);
  console.log(`✅ Environment saved to ${envPath}`);

  // Reveal secrets only after the probe has accepted the mapping and both
  // files are on disk. Printing a freshly minted key and then aborting left
  // merchants sharing a secret that was never written (#27936).
  if (!(existingApiKey && existingPendingApiKey)) {
    if (pendingApiKey) {
      // Deliberately reveal only the new secret, never the retained current one.
      console.log(`✓ New staged API key: ${pendingApiKey}`);
      console.log(
        '⚠ Add and test this key in Kasbly, switch Kasbly to it, then rerun setup and choose to retire the previous key.\n',
      );
    } else {
      console.log(`✓ API key: ${currentApiKey}`);
      console.log('⚠ Share this key with Kasbly only. Store it in your .env file.\n');
    }
  }

  // Topology-specific: only `bundled` starts the Compose file's Caddy
  // service, which is the only deployment `docker compose up -d` is correct
  // for. `custom`/`none` traffic reaches the connector directly (or from the
  // operator's own proxy) rather than from Caddy at 172.30.0.2, so starting
  // Caddy anyway would put an untrusted hop in front of the connector.
  if (proxyTopology === 'bundled') {
    console.log(
      hasExistingConfig || hasExistingEnv
        ? '\n   Restart the connector: docker compose restart connector'
        : '\n   Start the connector: docker compose up -d',
    );
    console.log(`   Verify the public endpoint: curl -fsS https://${connectorDomain}/health`);
    console.log(`   Give Kasbly this URL: https://${connectorDomain}`);
    if (bundledLoopbackDbTrap) {
      console.log(
        `\n   ℹ DB_HOST remains ${dbHost} for host-side setup and validation; Docker uses ` +
          'CONNECTOR_CONTAINER_DB_HOST=host.docker.internal inside the connector container (#28984).',
      );
      console.log(
        '   Make sure PostgreSQL accepts connections from the Docker bridge network ' +
          '(172.30.0.0/24), not only 127.0.0.1 — set listen_addresses in postgresql.conf and add ' +
          'a matching pg_hba.conf entry, then restart PostgreSQL.',
      );
    }
  } else if (proxyTopology === 'custom') {
    console.log(
      (hasExistingConfig || hasExistingEnv
        ? '\n   Restart your npm start process (binds :4000; the bundled '
        : '\n   Start the connector: npm run build && npm start (binds :4000; the bundled ') +
        'Caddy service is not started)',
    );
    console.log('   Put your own reverse proxy in front of this host on port 4000.');
    console.log('   Verify locally: curl -fsS http://localhost:4000/health');
    console.log('   Give Kasbly the public HTTPS URL your reverse proxy exposes.');
  } else {
    console.log(
      (hasExistingConfig || hasExistingEnv
        ? '\n   Restart your npm start process (or `docker compose restart connector` '
        : '\n   Start the connector: npm run build && npm start (or `docker compose up -d` ') +
        'after removing the caddy service from docker-compose.yml)',
    );
    console.log('   Verify locally: curl -fsS http://localhost:4000/health');
    console.log('   Give Kasbly this URL: http://<this-host>:4000 (no public DNS name needed)');
  }
  // Without one of these, every AI inventory card ends with a dead 🔗 after a
  // successful Test connection — Kasbly only builds a customer link from one
  // of these `attributes` keys (packages/shared's `providerCustomerListingUrl`)
  // or a Kasbly-side listingUrlTemplate (#25311). The connector has no access
  // to that Kasbly-side setting, so this can't tell whether a template is
  // already covering it — same limitation the original warning had — but it
  // now checks every alias Kasbly reads, not just `url`/`listingUrl`, so a
  // column already published under `listing_url`/`link`/`handle` no longer
  // trips a false warning (#28246).
  if (!hasListingUrlAttribute) {
    console.log(
      '   No listing-URL column was mapped: every AI product card will be missing its link ' +
        'until you either rerun setup and answer "Which column is the per-row customer-facing ' +
        'listing page?" (any permalink/href/canonical_url/product_link/listing_url-style column ' +
        'works — see Step 3a above) or set a listing URL template on this source in Kasbly.',
    );
  }
  printInventorySortIndexHint(selectedSchema, selectedTableName, idColumn, updatedAtColumn);

  await db.destroy();
}

/** Write generated credentials/config owner-only, repairing existing files on reruns. */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Make an owner-only timestamped backup beside a generated file before replacing it. */
export function backupPrivateFile(path: string, timestamp: Date = new Date()): string {
  const backupPath = `${path}.${timestamp.toISOString().replaceAll(/[:.]/g, '-')}.bak`;
  copyFileSync(path, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

/** Update wizard-owned env vars without dropping unrelated operator configuration. */
export function mergeEnvironmentFile(
  existing: string,
  values: Record<string, string | null>,
): string {
  let result = existing;
  for (const [name, value] of Object.entries(values)) {
    // A PEM CA bundle spans several lines, so a single-line `.*` pattern replaced
    // only the first line of an existing DB_SSL_CA and left the remainder of the
    // old certificate behind as bare lines that Compose's `env_file` parser
    // rejects. Match the whole entry: a quoted value may run across newlines.
    const pattern = new RegExp(
      `^[ \\t]*${name}=(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[^\\r\\n]*)[ \\t]*\\r?\\n?`,
      'm',
    );
    if (value === null) {
      result = result.replace(pattern, '');
      continue;
    }
    const line = `${name}=${serializeEnvValue(value)}`;
    result = pattern.test(result)
      ? result.replace(pattern, () => `${line}\n`)
      : `${result}${result.endsWith('\n') || !result ? '' : '\n'}${line}\n`;
  }
  return result.endsWith('\n') ? result : `${result}\n`;
}

/** Parse generated YAML with the prospective .env values, without changing the process environment. */
function validateProspectiveConfig(yamlContent: string, envContent: string): void {
  const envValues = parse(envContent);
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(envValues)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    parseConnectorConfig(yamlContent);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Load the existing config with its local .env values, without changing the process environment. */
export function loadExistingSetupConfig(configPath: string, envPath: string): ConnectorConfig {
  const envValues = existsSync(envPath) ? parse(readFileSync(envPath, 'utf-8')) : {};
  const addedNames: string[] = [];
  for (const [name, value] of Object.entries(envValues)) {
    if (process.env[name] === undefined) {
      process.env[name] = value;
      addedNames.push(name);
    }
  }
  try {
    return loadConfig(configPath);
  } finally {
    for (const name of addedNames) delete process.env[name];
  }
}

/** Convert the legacy container-only host value back to the host-side default on reruns. */
export function getSetupHostDefault(host: string | undefined): string {
  return host === 'host.docker.internal' ? 'localhost' : (host ?? 'localhost');
}

function isPublicImageUrlOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

/** Format a concise YAML-style preview of changes to wizard-owned inventory mappings. */
export function formatInventoryDiff(
  previous: ConnectorConfig['resources']['inventory'],
  next: ConnectorConfig['resources']['inventory'],
): string {
  const previousLines = yaml
    .dump(previous, { lineWidth: 120, quoteStyle: 'double' })
    .trimEnd()
    .split('\n');
  const nextLines = yaml.dump(next, { lineWidth: 120, quoteStyle: 'double' }).trimEnd().split('\n');
  const nextLineSet = new Set(nextLines);
  const previousLineSet = new Set(previousLines);
  const changes = [
    ...previousLines.filter((line) => !nextLineSet.has(line)).map((line) => `- ${line}`),
    ...nextLines.filter((line) => !previousLineSet.has(line)).map((line) => `+ ${line}`),
  ];

  return changes.length > 0 ? changes.join('\n') : '  (no changes)';
}

function getExistingMappingSelection(
  value: string | undefined,
  columnNames: string[],
): string | undefined {
  if (!value || value.startsWith("'")) return undefined;
  const unquoted = value.match(/^"((?:[^"]|"")*)"$/)?.[1]?.replaceAll('""', '"') ?? value;
  return columnNames.includes(unquoted) ? unquoted : undefined;
}

function unquoteIdentifier(value: string): string {
  return value.match(/^"((?:[^"]|"")*)"$/)?.[1]?.replaceAll('""', '"') ?? value;
}

function getFixedConfigValue(value: string | undefined): string | undefined {
  return value?.match(/^'([^']*)'$/)?.[1];
}

export function quoteIfNeeded(name: string): string {
  // Always quote generated PostgreSQL identifiers so reserved words and
  // case-sensitive or otherwise unusual column names remain valid SQL.
  return `"${name.replaceAll('"', '""')}"`;
}

const PEM_CERTIFICATE_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_CERTIFICATE_END = '-----END CERTIFICATE-----';

/**
 * Read the PEM the operator pointed setup at.
 *
 * The prompt asks for a path rather than the certificate body because
 * `@inquirer/prompts`' `input` is a single-line readline prompt: a pasted PEM
 * submits at its first newline, leaving `-----BEGIN CERTIFICATE-----` as the
 * trust anchor and feeding the base64 body to the following prompts.
 */
export function readCaCertificate(path: string): string {
  return readFileSync(resolve(path.trim()), 'utf-8').trim();
}

/** Reject a path that is missing, unreadable, or not a complete PEM certificate. */
export function validateCaCertificatePath(value: string): true | string {
  const path = value.trim();
  if (!path) return 'A path to a PEM CA certificate or bundle is required.';

  let contents: string;
  try {
    contents = readCaCertificate(path);
  } catch {
    return `Cannot read ${path}. Enter the path to a PEM CA certificate or bundle.`;
  }

  if (!contents.includes(PEM_CERTIFICATE_BEGIN) || !contents.includes(PEM_CERTIFICATE_END)) {
    return `${path} is not a complete PEM certificate: expected ${PEM_CERTIFICATE_BEGIN} … ${PEM_CERTIFICATE_END}.`;
  }

  return true;
}

async function collectTlsSettings(requiresTls: boolean): Promise<DatabaseTlsSettings> {
  if (!requiresTls) return { enabled: false, rejectUnauthorized: true };

  const tlsMode = await select({
    message: 'TLS certificate verification:',
    choices: [
      {
        name: 'Verify with the system CA store (recommended)',
        value: 'system-ca',
      },
      {
        name: 'Supply a PEM CA certificate/bundle',
        value: 'custom-ca',
      },
      {
        name: 'Disable verification (temporary escape hatch)',
        value: 'insecure',
      },
    ],
  });

  if (tlsMode === 'custom-ca') {
    const caPath = await input({
      message: 'Path to the PEM CA certificate or bundle:',
      validate: validateCaCertificatePath,
    });
    return { enabled: true, ca: readCaCertificate(caPath), rejectUnauthorized: true };
  }

  return { enabled: true, rejectUnauthorized: tlsMode !== 'insecure' };
}

export function serializeEnvValue(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }

  // Backticks are dotenv-only quoting: Docker Compose's `env_file` parser does
  // not strip them, so a value containing `'` must go straight to double
  // quotes instead (#26518). Guard those against `"` and `\` too — dotenv
  // keeps `\"`/`\\` literal while Compose unescapes them, the other point
  // where the two parsers diverge.
  if (!/["\\]/.test(value)) {
    return `"${value}"`;
  }

  throw new Error(
    'Environment value contains both a single quote and a double quote or backslash; ' +
      'no quoting works in both dotenv and Docker Compose env_file — set this variable manually.',
  );
}
