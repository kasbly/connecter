import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import yaml from 'js-yaml';
import { introspectDatabase, type IntrospectedTable } from './introspect.js';
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

export async function runWizard(): Promise<void> {
  console.log('\n🔧 Kasbly Connector Setup\n');

  // Step 1: Database Connection
  console.log('Step 1: Database Connection');
  const dbType = await select({
    message: 'Database type:',
    choices: [
      { name: 'PostgreSQL', value: 'postgres' as const },
    ],
  });
  const dbHost = await input({ message: 'Host:', default: 'localhost' });
  const dbPort = await input({ message: 'Port:', default: '5432' });
  const dbName = await input({ message: 'Database name:' });
  const dbUser = await input({ message: 'Username:' });
  const dbPassword = await input({ message: 'Password:', transformer: () => '****' });

  console.log('\nConnecting...');
  const { db, result } = await introspectDatabase({
    type: dbType,
    host: dbHost,
    port: parseInt(dbPort, 10),
    database: dbName,
    user: dbUser,
    password: dbPassword,
  });
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

  console.log('  Auto-detected field mappings:');
  for (const s of suggestions) {
    console.log(`    ${s.columnName} → ${s.suggestedMapping} (${s.mappingType}, ${s.confidence})`);
  }

  const allColumnNames = selectedTable.columns.map((c) => c.name);
  const suggestedColumnNames = new Set(suggestions.map((s) => s.columnName));

  // Let user select which columns to include as attributes (for unmapped columns)
  const unmappedColumns = allColumnNames.filter(
    (name) =>
      !suggestedColumnNames.has(name) &&
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
    suggestions,
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
  const relationSuggestions = suggestRelations(selectedTableName, result.tables, result.foreignKeys);
  const relations: Record<string, unknown> = {};

  for (const suggestion of relationSuggestions) {
    const relTable = result.tables.find((t) => t.name === suggestion.table);
    if (!relTable) continue;

    const addRelation = await confirm({
      message: `Add relation: ${suggestion.table} (${suggestion.relationType}, FK: ${suggestion.foreignKeyColumn})?`,
      default: suggestion.confidence !== 'low',
    });

    if (addRelation) {
      const fieldsMap: Record<string, string> = {};
      for (const col of relTable.columns) {
        if (col.name === suggestion.foreignKeyColumn) continue;
        if (col.isPrimaryKey) continue;
        fieldsMap[col.name] = quoteIfNeeded(col.name);
      }

      const relation: Record<string, unknown> = {
        table: suggestion.table,
        foreignKey: quoteIfNeeded(suggestion.foreignKeyColumn),
        referenceKey: idColumn,
        fields: fieldsMap,
      };

      if (suggestion.relationType === 'images') {
        // Find the URL column
        const urlCol = relTable.columns.find((c) =>
          /url$/i.test(c.name) || /^src$/i.test(c.name),
        );
        if (urlCol) {
          relation['imageUrlField'] = urlCol.name;
        }
      } else if (suggestion.relationType === 'features') {
        // Find the name/value column to flatten
        const nameCol = relTable.columns.find((c) =>
          /name/i.test(c.name) || /value/i.test(c.name) || /label/i.test(c.name),
        );
        if (nameCol) {
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

  fields['externalId'] = idColumn;
  for (const s of suggestions) {
    if (s.mappingType === 'field') {
      fields[s.suggestedMapping] = quoteIfNeeded(s.columnName);
    } else {
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
      ssl: false,
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
        ...(baseFilterParts.length > 0
          ? { baseFilter: baseFilterParts.join(' AND ') }
          : {}),
        idColumn,
        ...(updatedAtColumn ? { updatedAtColumn } : {}),
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

  // Write config file
  const configPath = resolve('connector.config.yml');
  const yamlContent = yaml.dump(config, { lineWidth: 120, quotingType: '"' });
  writeFileSync(configPath, yamlContent, 'utf-8');
  console.log(`✅ Configuration saved to ${configPath}`);

  // Write .env file
  const envPath = resolve('.env');
  const envContent = [
    `DB_HOST=${dbHost}`,
    `DB_NAME=${dbName}`,
    `DB_USER=${dbUser}`,
    `DB_PASSWORD=${dbPassword}`,
    `CONNECTOR_API_KEY=${apiKey}`,
  ].join('\n') + '\n';
  writeFileSync(envPath, envContent, 'utf-8');
  console.log(`✅ Environment saved to ${envPath}`);

  console.log('\n   Start the connector: docker compose up -d\n');

  await db.destroy();
}

function quoteIfNeeded(name: string): string {
  // Quote if the name has uppercase letters or is a reserved word
  if (/[A-Z]/.test(name)) {
    return `"${name}"`;
  }
  return name;
}
