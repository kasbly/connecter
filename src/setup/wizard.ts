import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, select, confirm, checkbox, password } from '@inquirer/prompts';
import { parse } from 'dotenv';
import * as yaml from 'js-yaml';
import { loadConfig } from '../config/config.loader.js';
import type {
  ConnectorConfig,
  RelationConfig,
  UnknownStatusPolicy,
} from '../config/config.types.js';
import { introspectDatabase } from './introspect.js';
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
  suggestSoftDeleteColumn,
  suggestRelations,
  suggestSearchableColumns,
  suggestFilterableColumns,
  type FilterableColumnSuggestion,
} from './suggest.js';
import {
  mapRowToInventoryItem,
  resolveColumnValue,
  UNMAPPED_STATUS_FALLBACK,
  validateInventoryItemWireContract,
} from '../mapping/field-mapper.js';

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

const UNMAPPED_FIELD_VALUE = '\0unmapped';
const FIXED_VALUE_FIELD_VALUE = '\0fixed-value';
const FIXED_VALUE_FIELDS = new Set<FieldMappingTarget>(['currency', 'category', 'status']);

interface FieldMappingPrompt {
  message: string;
  choices: Array<{ name: string; value: string }>;
  default: string;
}

interface MappingColumn {
  name: string;
  type: string;
}

function isCompatibleFieldColumn(field: FieldMappingTarget, type: string): boolean {
  const normalizedType = type.trim().toLowerCase();
  if (field === 'price') {
    return /^(smallint|integer|bigint|decimal|numeric|real|double precision|money|float)/.test(
      normalizedType,
    );
  }

  if (field === 'images') {
    return /(char|text|json|xml|array)/.test(normalizedType);
  }

  return /(char|text|json|xml|uuid|enum)/.test(normalizedType);
}

/**
 * How many distinct source status values the wizard asks about. A high-cardinality
 * column would otherwise present one unanswerable prompt per value with no way out
 * but Ctrl-C, which discards the whole session. Anything past the cap — and anything
 * explicitly left unmapped — is covered by `unknownStatusPolicy`.
 */
export const STATUS_VALUE_PROMPT_LIMIT = 25;

async function collectStatusValues(
  db: Awaited<ReturnType<typeof introspectDatabase>>['db'],
  schema: string,
  table: string,
  column: string,
): Promise<StatusValuesConfig> {
  // Schema-qualified: the client's search_path does not necessarily contain the
  // schema the operator selected, so a bare table reference cannot be resolved.
  const values = (await db
    .withSchema(schema)
    .table(table)
    .distinct(column)
    .whereNotNull(column)
    .pluck(column)) as unknown[];
  const distinctValues = Array.from(new Set(values.map((value) => String(value)))).sort();
  const presentedValues = distinctValues.slice(0, STATUS_VALUE_PROMPT_LIMIT);
  const skippedCount = distinctValues.length - presentedValues.length;
  if (skippedCount > 0) {
    console.log(
      `\n"${column}" has ${distinctValues.length} distinct values. Mapping the first ${presentedValues.length}; the remaining ${skippedCount} use the unknown-status policy chosen next.`,
    );
  }
  const statusValues: StatusValuesConfig = {};

  for (const value of presentedValues) {
    const status = await select<InventoryStatus | typeof UNMAPPED_FIELD_VALUE>({
      message: `Which Kasbly status matches "${value}"?`,
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

/** Build the selectable mapping choices for one standard inventory field. */
export function getFieldMappingPrompt(
  field: FieldMappingTarget,
  columns: Array<string | MappingColumn>,
  suggestedColumn?: string,
): FieldMappingPrompt {
  const columnNames = columns
    .filter(
      (column): column is string | MappingColumn =>
        typeof column === 'string' || isCompatibleFieldColumn(field, column.type),
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
        ? 'Which column contains the images? (one URL, a PostgreSQL text array, or a JSON array; e.g. ["https://example.com/photo.jpg"])'
        : `Which column contains the ${field}?`,
    choices,
    default:
      suggestedColumn && columnNames.includes(suggestedColumn)
        ? suggestedColumn
        : UNMAPPED_FIELD_VALUE,
  };
}

export function toConfigLiteral(value: string): string {
  return `'${value}'`;
}

export function shouldDefaultToTls(host: string): boolean {
  return !['localhost', '127.0.0.1', '::1'].includes(host.trim().toLowerCase());
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

/**
 * The connector reads forwarded headers only from this allowlist, so the value
 * has to match the proxy actually deployed in front of it. `undefined` means no
 * proxy: the raw socket peer is used, which is the fail-closed default.
 */
async function collectTrustedProxies(existing: string | undefined): Promise<string | undefined> {
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

  if (topology === 'none') return undefined;
  if (topology === 'bundled') return BUNDLED_PROXY_ADDRESS;

  const proxies = await input({
    message: 'Trusted proxy IPs/CIDRs (comma-separated):',
    default: existing === BUNDLED_PROXY_ADDRESS ? undefined : existing,
    validate: (value) =>
      value.trim() ? true : 'Enter the direct proxy IPs/CIDRs, or choose "None" instead.',
  });
  return proxies.trim();
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

  const existingConfig = hasExistingConfig
    ? loadExistingSetupConfig(configPath, envPath)
    : undefined;
  const existingEnv = hasExistingEnv ? parse(readFileSync(envPath, 'utf-8')) : {};
  const existingApiKey = existingEnv['CONNECTOR_API_KEY'];
  const existingPendingApiKey = existingEnv['CONNECTOR_API_KEY_PENDING'];

  // Step 1: Database Connection
  console.log('Step 1: Database Connection');
  const dbType = await select({
    message: 'Database type:',
    choices: [{ name: 'PostgreSQL', value: 'postgres' as const }],
  });
  const dbHost = await input({
    message: 'Host:',
    default: existingConfig?.database.host ?? 'localhost',
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
    existingConfig?.database.password ?? (await password({ message: 'Password:', mask: true }));
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
  console.log(`✓ Connected! Found ${result.tables.length} tables.\n`);

  // Step 2: Select Inventory Table
  console.log('Step 2: Select Your Inventory Table');
  const tableChoices = result.tables
    .sort((a, b) => b.rowCount - a.rowCount)
    .map((t) => ({
      name: `${t.name} (${t.rowCount.toLocaleString()} rows)`,
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

  // Step 3: Field Mapping
  console.log('\nStep 3: Field Mapping');
  const suggestions = suggestFieldMappings(selectedTable.columns);
  const existingInventory = existingConfig?.resources.inventory;
  const idColumn =
    getExistingMappingSelection(
      existingInventory?.idColumn,
      selectedTable.columns.map((column) => column.name),
    ) ??
    suggestIdColumn(selectedTable.columns) ??
    'id';
  const updatedAtColumn =
    getExistingMappingSelection(
      existingInventory?.updatedAtColumn,
      selectedTable.columns.map((column) => column.name),
    ) ?? suggestUpdatedAtColumn(selectedTable.columns);
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

  // Let user select which remaining columns to include as attributes.
  const unmappedColumns = allColumnNames.filter(
    (name) =>
      !mappedColumnNames.has(name) &&
      name !== idColumn &&
      name !== updatedAtColumn &&
      !/Id$/.test(name) &&
      !/_id$/.test(name) &&
      !/At$/.test(name) &&
      !/_at$/.test(name),
  );

  let additionalAttributes: string[] = [];
  if (unmappedColumns.length > 0) {
    additionalAttributes = await checkbox({
      message: 'Select additional columns to include as attributes:',
      choices: unmappedColumns.map((name) => ({
        name,
        value: name,
        checked: Boolean(existingConfig?.resources.inventory.attributes?.[name]),
      })),
    });
  }

  // Step 3b: Searchable Columns
  console.log('\nStep 3b: Search Configuration');
  const searchSuggestions = suggestSearchableColumns(selectedTable.columns);
  const allTextColumns = selectedTable.columns
    .filter((c) => ['text', 'character varying', 'varchar'].includes(c.type.toLowerCase()))
    .filter((c) => !c.isPrimaryKey)
    .map((c) => c.name);
  const suggestedSearchNames = new Set(searchSuggestions.map((s) => s.columnName));

  let searchableColumns: string[] = [];
  if (allTextColumns.length > 0) {
    searchableColumns = await checkbox({
      message: 'Which columns should be searchable? (full-text search)',
      choices: allTextColumns.map((name) => ({
        name,
        value: name,
        checked:
          existingConfig?.resources.inventory.searchableColumns?.includes(quoteIfNeeded(name)) ??
          suggestedSearchNames.has(name),
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
        checked: existingConfig
          ? Boolean(existingConfig.resources.inventory.filterableColumns?.[f.filterName])
          : true,
      })),
    });
    const selectedNames = new Set(filterChoiceNames);
    selectedFilters = filterSuggestions.filter((f) => selectedNames.has(f.filterName));
  }

  // Step 4: Filters
  console.log('\nStep 4: Filters');
  const publishedColumn = suggestPublishedColumn(selectedTable.columns);
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

  for (const suggestion of relationSuggestions) {
    const relTable = result.tables.find((t) => t.name === suggestion.table);
    if (!relTable) continue;

    // Relation names are also the keys used to load relation rows at runtime. Keep
    // a matching existing key when rerunning setup, but use the source table name
    // for new image relations so accepting more than one cannot overwrite a
    // previous image source.
    const existingRelationEntry = Object.entries(
      existingConfig?.resources.inventory.relations ?? {},
    ).find(
      ([, relation]) =>
        relation.table === suggestion.table &&
        unquoteIdentifier(relation.foreignKey) === suggestion.foreignKeyColumn,
    );
    const relationName = existingRelationEntry?.[0] ?? suggestion.table;
    const existingRelation = existingRelationEntry?.[1];

    const addRelation = await confirm({
      message: `Add relation: ${suggestion.table} (${suggestion.relationType}, FK: ${suggestion.foreignKeyColumn})?`,
      default: Boolean(existingRelation) || suggestion.confidence !== 'low',
    });

    if (addRelation) {
      const selectableColumns = relTable.columns.filter(
        (col) => col.name !== suggestion.foreignKeyColumn && !col.isPrimaryKey,
      );
      const defaultColumn =
        suggestion.relationType === 'images'
          ? selectableColumns.find((col) => /url$/i.test(col.name) || /^src$/i.test(col.name))
          : suggestion.relationType === 'features'
            ? selectableColumns.find(
                (col) =>
                  /name/i.test(col.name) || /value/i.test(col.name) || /label/i.test(col.name),
              )
            : undefined;
      const selectedColumns = await checkbox({
        message: `Select columns from ${suggestion.table} to expose:`,
        choices: selectableColumns.map((col) => ({
          name: col.name,
          value: col.name,
          checked: Boolean(existingRelation?.fields[col.name]) || col.name === defaultColumn?.name,
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
        referenceKey: quoteIfNeeded(idColumn),
        fields: fieldsMap,
      };

      if (suggestion.relationType === 'images') {
        // Find the URL column
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
      } else if (suggestion.relationType === 'features') {
        // Find the name/value column to flatten
        const nameCol = relTable.columns.find(
          (c) => /name/i.test(c.name) || /value/i.test(c.name) || /label/i.test(c.name),
        );
        if (nameCol && selectedColumnNames.has(nameCol.name)) {
          relation['flatten'] = nameCol.name;
        }
      }

      relations[relationName] = relation;
    }
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
      : (existingApiKey ?? (await input({ message: 'Enter your API key:' })));

    currentApiKey = existingApiKey ?? generatedOrEnteredKey;
    if (existingApiKey && generateKey) pendingApiKey = generatedOrEnteredKey;

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

  // Both values below are required by the deployment this wizard ends by
  // recommending: `docker compose up -d` refuses to resolve without
  // CONNECTOR_DOMAIN, and without trustedProxies every request behind the
  // bundled proxy is attributed to Caddy's internal address.
  const connectorDomain = (
    await input({
      message: 'Public DNS name for this connector (its A/AAAA record must point at this host):',
      default: existingEnv['CONNECTOR_DOMAIN'],
      validate: (value) =>
        isPublicHostname(value) ||
        'Enter a DNS name such as connector.merchant.example — no scheme, port, or path.',
    })
  ).trim();
  const trustedProxies = await collectTrustedProxies(existingConfig?.server.trustedProxies);

  // Build config object
  // Everything below is selected by this wizard, so rebuild it instead of
  // overlaying selections onto the previous inventory mapping. This makes an
  // explicit "No" or an empty checkbox selection remove stale configuration.
  const fields: Record<string, string> = {};
  const attributes: Record<string, string> = {};

  fields['externalId'] = quoteIfNeeded(idColumn);
  Object.assign(fields, fieldMappings);
  for (const s of suggestions) {
    if (s.mappingType === 'attribute' && !mappedColumnNames.has(s.columnName)) {
      attributes[s.suggestedMapping] = quoteIfNeeded(s.columnName);
    }
  }
  for (const attrName of additionalAttributes) {
    attributes[attrName] = quoteIfNeeded(attrName);
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
      ...existingConfig?.database,
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
        fields,
        ...(statusValues ? { statusValues } : {}),
        ...(unknownStatusPolicy ? { unknownStatusPolicy } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(searchableColumns.length > 0
          ? { searchableColumns: searchableColumns.map(quoteIfNeeded) }
          : {}),
        ...(selectedFilters.length > 0
          ? {
              filterableColumns: {
                ...Object.fromEntries(
                  selectedFilters.map((f) => [
                    f.filterName,
                    { column: quoteIfNeeded(f.columnName), type: f.filterType },
                  ]),
                ),
              },
            }
          : {}),
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

  // Validate a real mapped row before persisting a setup that would otherwise
  // look healthy until Kasbly consumes it. Empty tables remain valid: there is
  // no sample row to disprove the mapping yet.
  try {
    const sampleRow = await db.withSchema(selectedSchema).table(selectedTableName).first();
    if (sampleRow) {
      validateInventoryItemWireContract(
        mapRowToInventoryItem(
          sampleRow as Record<string, unknown>,
          config.resources.inventory,
          new Map(),
        ),
        config.resources.inventory.fields['images']
          ? [
              resolveColumnValue(
                sampleRow as Record<string, unknown>,
                config.resources.inventory.fields['images'],
              ),
            ]
          : [],
      );
    }
  } catch (error) {
    console.error(
      `Cannot save configuration: inventory sample violates the wire contract: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await db.destroy();
    return;
  }

  // Write config file
  if (hasExistingConfig) backupPrivateFile(configPath);
  if (hasExistingEnv) backupPrivateFile(envPath);
  // js-yaml v5 replaced `quotingType: '"'` with `quoteStyle: 'double'`.
  const yamlContent = yaml.dump(config, { lineWidth: 120, quoteStyle: 'double' });
  writePrivateFile(configPath, yamlContent);
  console.log(`✅ Configuration saved to ${configPath}`);

  // Update generated values while preserving operator-owned .env settings.
  const envContent = mergeEnvironmentFile(hasExistingEnv ? readFileSync(envPath, 'utf-8') : '', {
    DB_HOST: dbHost,
    DB_NAME: dbName,
    DB_USER: dbUser,
    DB_PASSWORD: dbPassword,
    ...(tls.ca ? { DB_SSL_CA: tls.ca } : {}),
    CONNECTOR_API_KEY: currentApiKey,
    CONNECTOR_API_KEY_PENDING: pendingApiKey ?? null,
    CONNECTOR_DOMAIN: connectorDomain,
  });
  writePrivateFile(envPath, envContent);
  console.log(`✅ Environment saved to ${envPath}`);

  console.log('\n   Start the connector: docker compose up -d');
  console.log(`   Verify the public endpoint: curl -fsS https://${connectorDomain}/health`);
  console.log(`   Give Kasbly this URL: https://${connectorDomain}\n`);

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
    const pattern = new RegExp(`^\\s*${name}=.*(?:\\n|$)`, 'm');
    if (value === null) {
      result = result.replace(pattern, '');
      continue;
    }
    const line = `${name}=${serializeEnvValue(value)}`;
    result = pattern.test(result)
      ? result.replace(pattern, `${line}\n`)
      : `${result}${result.endsWith('\n') || !result ? '' : '\n'}${line}\n`;
  }
  return result.endsWith('\n') ? result : `${result}\n`;
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
    const ca = await input({
      message: 'PEM CA certificate or bundle:',
      validate: (value) => (value.trim() ? true : 'A PEM CA certificate or bundle is required.'),
    });
    return { enabled: true, ca, rejectUnauthorized: true };
  }

  return { enabled: true, rejectUnauthorized: tlsMode !== 'insecure' };
}

export function serializeEnvValue(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }

  if (!value.includes('`')) {
    return `\`${value}\``;
  }

  if (!value.includes('"')) {
    return `"${value}"`;
  }

  throw new Error('Environment value contains every supported dotenv quote delimiter');
}
