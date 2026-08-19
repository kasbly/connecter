import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, select, confirm, checkbox, password } from '@inquirer/prompts';
import { parse } from 'dotenv';
import * as yaml from 'js-yaml';
import { loadConfig } from '../config/config.loader.js';
import type { ConnectorConfig } from '../config/config.types.js';
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

async function collectStatusValues(
  db: Awaited<ReturnType<typeof introspectDatabase>>['db'],
  table: string,
  column: string,
): Promise<StatusValuesConfig> {
  const values = await db(table).distinct(column).whereNotNull(column).pluck(column);
  const statusValues: StatusValuesConfig = {};

  for (const value of Array.from(new Set(values.map(String))).sort()) {
    const status = await select<InventoryStatus>({
      message: `Which Kasbly status matches "${value}"?`,
      choices: INVENTORY_STATUSES.map((inventoryStatus) => ({
        name: inventoryStatus,
        value: inventoryStatus,
      })),
    });
    (statusValues[status] ??= []).push(value);
  }

  return statusValues;
}

/** Build the selectable mapping choices for one standard inventory field. */
export function getFieldMappingPrompt(
  field: FieldMappingTarget,
  columnNames: string[],
  suggestedColumn?: string,
): FieldMappingPrompt {
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
    message: `Which column contains the ${field}?`,
    choices,
    default: suggestedColumn ?? UNMAPPED_FIELD_VALUE,
  };
}

export function toConfigLiteral(value: string): string {
  return `'${value}'`;
}

export function shouldDefaultToTls(host: string): boolean {
  return !['localhost', '127.0.0.1', '::1'].includes(host.trim().toLowerCase());
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
  const mappedColumnNames = new Set<string>();
  for (const field of FIELD_MAPPING_TARGETS) {
    const suggestedColumn = suggestions.find(
      (suggestion) => suggestion.mappingType === 'field' && suggestion.suggestedMapping === field,
    )?.columnName;
    const existingMapping = existingConfig?.resources.inventory.fields[field];
    const existingSelection = getExistingMappingSelection(existingMapping, allColumnNames);
    const prompt = getFieldMappingPrompt(
      field,
      allColumnNames,
      existingSelection ?? suggestedColumn,
    );
    const selectedValue = await select(prompt);

    if (selectedValue === UNMAPPED_FIELD_VALUE) continue;
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
      statusValues = await collectStatusValues(db, selectedTableName, selectedValue);
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
  const relations: Record<string, unknown> = { ...existingConfig?.resources.inventory.relations };

  for (const suggestion of relationSuggestions) {
    const relTable = result.tables.find((t) => t.name === suggestion.table);
    if (!relTable) continue;

    const addRelation = await confirm({
      message: `Add relation: ${suggestion.table} (${suggestion.relationType}, FK: ${suggestion.foreignKeyColumn})?`,
      default:
        Boolean(existingConfig?.resources.inventory.relations?.[suggestion.relationType]) ||
        suggestion.confidence !== 'low',
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
          checked:
            Boolean(
              existingConfig?.resources.inventory.relations?.[suggestion.relationType]?.fields[
                col.name
              ],
            ) || col.name === defaultColumn?.name,
        })),
      });
      const selectedColumnNames = new Set(selectedColumns);
      const fieldsMap: Record<string, string> = {};
      for (const col of selectableColumns) {
        if (!selectedColumnNames.has(col.name)) continue;
        fieldsMap[col.name] = quoteIfNeeded(col.name);
      }

      const relation: Record<string, unknown> = {
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
            default: Boolean(
              existingConfig?.resources.inventory.relations?.[suggestion.relationType]?.orderBy,
            ),
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

      relations[suggestion.relationType === 'images' ? 'images' : suggestion.table] = relation;
    }
  }

  // Step 6: Security
  console.log('\nStep 6: Security');
  const generateKey = await confirm(
    existingApiKey
      ? {
          message:
            'Generate a new API key? This invalidates the key currently configured in Kasbly; update it in the Kasbly dashboard.',
          default: false,
        }
      : { message: 'Generate API key?', default: true },
  );

  const apiKey = generateKey
    ? `kc_${randomBytes(24).toString('hex')}`
    : (existingApiKey ?? (await input({ message: 'Enter your API key:' })));

  console.log(`✓ API key: ${apiKey}`);
  console.log(
    generateKey && existingApiKey
      ? '⚠ This replaces the existing key. Update it in the Kasbly dashboard before restarting.\n'
      : '⚠ Share this key with Kasbly only. Store it in your .env file.\n',
  );

  // Build config object
  const fields: Record<string, string> = { ...existingConfig?.resources.inventory.fields };
  const attributes: Record<string, string> = { ...existingConfig?.resources.inventory.attributes };

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
    server: existingConfig?.server ?? { port: 4000, host: '0.0.0.0' },
    auth: {
      apiKeys: [{ key: '${CONNECTOR_API_KEY}', label: 'kasbly-production' }],
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
        ...existingConfig?.resources.inventory,
        table: selectedTableName,
        ...(baseFilterParts.length > 0 ? { baseFilter: baseFilterParts.join(' AND ') } : {}),
        idColumn: quoteIfNeeded(idColumn),
        ...(updatedAtColumn ? { updatedAtColumn: quoteIfNeeded(updatedAtColumn) } : {}),
        fields,
        ...(statusValues ? { statusValues } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(searchableColumns.length > 0
          ? { searchableColumns: searchableColumns.map(quoteIfNeeded) }
          : {}),
        ...(selectedFilters.length > 0
          ? {
              filterableColumns: {
                ...existingConfig?.resources.inventory.filterableColumns,
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
        `  ${relationName}: ${columnNames.length > 0 ? columnNames.join(', ') : '(none)'}`,
      );
    }
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
    CONNECTOR_API_KEY: apiKey,
  });
  writePrivateFile(envPath, envContent);
  console.log(`✅ Environment saved to ${envPath}`);

  console.log('\n   Start the connector: docker compose up -d\n');

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
export function mergeEnvironmentFile(existing: string, values: Record<string, string>): string {
  let result = existing;
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${serializeEnvValue(value)}`;
    const pattern = new RegExp(`^\\s*${name}=.*$`, 'm');
    result = pattern.test(result)
      ? result.replace(pattern, line)
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

function getExistingMappingSelection(
  value: string | undefined,
  columnNames: string[],
): string | undefined {
  if (!value || value.startsWith("'")) return undefined;
  const unquoted = value.match(/^"((?:[^"]|"")*)"$/)?.[1]?.replaceAll('""', '"') ?? value;
  return columnNames.includes(unquoted) ? unquoted : undefined;
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
