import knex, { type Knex } from 'knex';

export interface IntrospectedTable {
  name: string;
  rowCount: number;
  columns: IntrospectedColumn[];
}

export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface ForeignKeyInfo {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface IntrospectionResult {
  tables: IntrospectedTable[];
  foreignKeys: ForeignKeyInfo[];
}

export interface DbConnectOptions {
  type: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  sslCa?: string;
  sslRejectUnauthorized?: boolean;
  /** PostgreSQL schema to inspect. Defaults to public. */
  schema?: string;
}

export interface DatabaseConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
}

/** Build the knex connection options used by both the setup probe and the connector at runtime. */
export function createDatabaseConnectionOptions(
  options: DbConnectOptions,
): DatabaseConnectionOptions {
  return {
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    ssl: options.ssl
      ? {
          rejectUnauthorized: options.sslRejectUnauthorized !== false,
          ...(options.sslCa ? { ca: options.sslCa } : {}),
        }
      : false,
  };
}

/** PostgreSQL errors emitted when a server rejects a plaintext connection. */
export function isTlsRequiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return /no pg_hba\.conf entry.*no encryption|connection is insecure.*sslmode=require|ssl is required/i.test(
    error.message,
  );
}

export async function introspectDatabase(options: DbConnectOptions): Promise<{
  db: Knex;
  result: IntrospectionResult;
  retriedWithTls: boolean;
}> {
  let connectionOptions = options;
  let db = createDatabaseClient(connectionOptions);
  let retriedWithTls = false;

  try {
    await db.raw('SELECT 1');
  } catch (error) {
    if (options.ssl || !isTlsRequiredError(error)) throw error;

    await db.destroy();
    connectionOptions = { ...options, ssl: true, sslRejectUnauthorized: true };
    db = createDatabaseClient(connectionOptions);
    await db.raw('SELECT 1');
    retriedWithTls = true;
  }

  const schema = options.schema ?? 'public';
  const tables = await introspectTables(db, schema);
  const foreignKeys = await introspectForeignKeys(db, schema);

  return { db, result: { tables, foreignKeys }, retriedWithTls };
}

function createDatabaseClient(options: DbConnectOptions): Knex {
  return knex({
    client: options.type === 'postgres' ? 'pg' : 'mysql2',
    connection: createDatabaseConnectionOptions(options),
  });
}

async function introspectTables(db: Knex, schema: string): Promise<IntrospectedTable[]> {
  const tableRows = await db.raw<{ rows: { tablename: string }[] }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename`,
    [schema],
  );

  const tables: IntrospectedTable[] = [];

  for (const tableRow of tableRows.rows) {
    const tableName = tableRow.tablename;

    // Get columns
    const columnRows = await db.raw<{
      rows: {
        column_name: string;
        data_type: string;
        is_nullable: string;
      }[];
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = ? AND table_schema = ?
       ORDER BY ordinal_position`,
      [tableName, schema],
    );

    // Get primary key columns
    const pkRows = await db.raw<{ rows: { column_name: string }[] }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_name = ?
       AND tc.table_schema = ?`,
      [tableName, schema],
    );
    const pkColumns = new Set(pkRows.rows.map((r) => r.column_name));

    const columns: IntrospectedColumn[] = columnRows.rows.map((col) => ({
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === 'YES',
      isPrimaryKey: pkColumns.has(col.column_name),
    }));

    // Get row count (approximate for large tables)
    const countResult = await db.raw<{ rows: { estimate: string }[] }>(
      `SELECT reltuples::bigint AS estimate
       FROM pg_class
       WHERE relname = ? AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ?)`,
      [tableName, schema],
    );
    const rowCount = Math.max(0, Number(countResult.rows[0]?.estimate ?? 0));

    tables.push({ name: tableName, rowCount, columns });
  }

  return tables;
}

async function introspectForeignKeys(db: Knex, schema: string): Promise<ForeignKeyInfo[]> {
  const fkRows = await db.raw<{
    rows: {
      from_table: string;
      from_column: string;
      to_table: string;
      to_column: string;
    }[];
  }>(
    `SELECT
       tc.table_name AS from_table,
       kcu.column_name AS from_column,
       ccu.table_name AS to_table,
       ccu.column_name AS to_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = ?
     ORDER BY tc.table_name`,
    [schema],
  );

  return fkRows.rows.map((row) => ({
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toTable: row.to_table,
    toColumn: row.to_column,
  }));
}
