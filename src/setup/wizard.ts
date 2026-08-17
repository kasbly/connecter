import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, select, confirm, checkbox, password } from '@inquirer/prompts';
import * as yaml from 'js-yaml';
import { introspectDatabase } from './introspect.js';
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
const FIXED_VALUE_FIELDS = new Set<FieldMappingTarget>(['currency', 'category']);

interface FieldMappingPrompt {
  message: string;
  choices: Array<{ name: string; value: string }>;
  default: string;
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

  // Step 1: Database Connection
  console.log('Step 1: Database Connection');
  const dbType = await select({
    message: 'Database type:',
    choices: [{ name: 'PostgreSQL', value: 'postgres' as const }],
  });
  const dbHost = await input({ message: 'Host:', default: 'localhost' });
  const dbPort = await input({ message: 'Port:', default: '5432' });
  const dbName = await input({ message: 'Database name:' });
  const dbUser = await input({ message: 'Username:' });
  const dbPassword = await password({ message: 'Password:', mask: true });
  const requiresTls = await confirm({
    message: 'Does this database require TLS?',
    default: shouldDefaultToTls(dbHost),
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
  });

  const selectedTable = result.tables.find((t) => t.name === selectedTableName)!;

  // Step 3: Field Mapping
  console.log('\nStep 3: Field Mapping');
  const suggestions = suggestFieldMappings(selectedTable.columns);
  const idColumn = suggestIdColumn(selectedTable.columns) ?? 'id';
  const updatedAtColumn = suggestUpdatedAtColumn(selectedTable.columns);
  const allColumnNames = selectedTable.columns.map((c) => c.name);

  const fieldMappings: Partial<Record<FieldMappingTarget, string>> = {};
  const mappedColumnNames = new Set<string>();
  for (const field of FIELD_MAPPING_TARGETS) {
    const suggestedColumn = suggestions.find(
      (suggestion) => suggestion.mappingType === 'field' && suggestion.suggestedMapping === field,
    )?.columnName;
    const selectedValue = await select(
      getFieldMappingPrompt(field, allColumnNames, suggestedColumn),
    );

    if (selectedValue === UNMAPPED_FIELD_VALUE) continue;
    if (selectedValue === FIXED_VALUE_FIELD_VALUE) {
      const fixedValue = await input({
        message: `Fixed ${field} value for every row:`,
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
        checked: false,
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
        checked: suggestedSearchNames.has(name),
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
        checked: true,
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
      default: true,
    });
    if (usePublished) {
      baseFilterParts.push(`${quoteIfNeeded(publishedColumn)} = true`);
    }
  }

  if (softDeleteColumn) {
    const excludeDeleted = await confirm({
      message: `Exclude soft-deleted items? (detected column: ${softDeleteColumn})`,
      default: true,
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
  const relations: Record<string, unknown> = {};

  for (const suggestion of relationSuggestions) {
    const relTable = result.tables.find((t) => t.name === suggestion.table);
    if (!relTable) continue;

    const addRelation = await confirm({
      message: `Add relation: ${suggestion.table} (${suggestion.relationType}, FK: ${suggestion.foreignKeyColumn})?`,
      default: suggestion.confidence !== 'low',
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
          checked: col.name === defaultColumn?.name,
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
  const generateKey = await confirm({
    message: 'Generate API key?',
    default: true,
  });

  const apiKey = generateKey
    ? `kc_${randomBytes(24).toString('hex')}`
    : await input({ message: 'Enter your API key:' });

  console.log(`✓ API key: ${apiKey}`);
  console.log('⚠ Share this key with Kasbly only. Store it in your .env file.\n');

  // Build config object
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
    version: 1,
    server: { port: 4000, host: '0.0.0.0' },
    auth: {
      apiKeys: [{ key: '${CONNECTOR_API_KEY}', label: 'kasbly-production' }],
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
      statementTimeoutMs: 10000,
      pool: { min: 2, max: 10 },
    },
    rateLimit: { maxRequests: 100, windowSeconds: 60 },
    audit: {
      enabled: true,
      filePath: './logs/audit.log',
      maxFileSizeMB: 50,
      retentionDays: 90,
    },
    resources: {
      inventory: {
        table: selectedTableName,
        ...(baseFilterParts.length > 0 ? { baseFilter: baseFilterParts.join(' AND ') } : {}),
        idColumn: quoteIfNeeded(idColumn),
        ...(updatedAtColumn ? { updatedAtColumn: quoteIfNeeded(updatedAtColumn) } : {}),
        fields,
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(searchableColumns.length > 0
          ? { searchableColumns: searchableColumns.map(quoteIfNeeded) }
          : {}),
        ...(selectedFilters.length > 0
          ? {
              filterableColumns: Object.fromEntries(
                selectedFilters.map((f) => [
                  f.filterName,
                  { column: quoteIfNeeded(f.columnName), type: f.filterType },
                ]),
              ),
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
  const configPath = resolve('connector.config.yml');
  // js-yaml v5 replaced `quotingType: '"'` with `quoteStyle: 'double'`.
  const yamlContent = yaml.dump(config, { lineWidth: 120, quoteStyle: 'double' });
  writePrivateFile(configPath, yamlContent);
  console.log(`✅ Configuration saved to ${configPath}`);

  // Write .env file
  const envPath = resolve('.env');
  const envContent =
    [
      `DB_HOST=${serializeEnvValue(dbHost)}`,
      `DB_NAME=${serializeEnvValue(dbName)}`,
      `DB_USER=${serializeEnvValue(dbUser)}`,
      `DB_PASSWORD=${serializeEnvValue(dbPassword)}`,
      ...(tls.ca ? [`DB_SSL_CA=${serializeEnvValue(tls.ca)}`] : []),
      `CONNECTOR_API_KEY=${serializeEnvValue(apiKey)}`,
    ].join('\n') + '\n';
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
