import knex, { type Knex } from 'knex';

export const SETUP_STATEMENT_TIMEOUT_MS = 10_000;

export interface IntrospectedTable {
  name: string;
  kind: 'table' | 'view' | 'materialized view';
  rowCount: number;
  columns: IntrospectedColumn[];
}

export interface IntrospectedColumn {
  name: string;
  type: string;
  /** PostgreSQL's underlying type name, which identifies user-defined enums. */
  udtName?: string;
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
  // Pin the search path to the schema the operator selected so an unqualified table
  // reference anywhere in setup resolves against it instead of failing (or, worse,
  // silently reading a same-named table in public).
  const searchPath = options.schema?.trim() || 'public';

  return knex({
    client: options.type === 'postgres' ? 'pg' : 'mysql2',
    connection: createDatabaseConnectionOptions(options),
    ...(options.type === 'postgres'
      ? {
          searchPath: [searchPath],
          pool: {
            afterCreate: (
              conn: { query: (sql: string, cb: (err: unknown) => void) => void },
              done: (err: unknown) => void,
            ) => {
              conn.query('SET default_transaction_read_only = ON', (err) => {
                if (err) {
                  done(err);
                  return;
                }
                conn.query(`SET statement_timeout = ${SETUP_STATEMENT_TIMEOUT_MS}`, done);
              });
            },
          },
        }
      : {}),
  });
}

async function introspectTables(db: Knex, schema: string): Promise<IntrospectedTable[]> {
  const tableRows = await db.raw<{
    rows: { name: string; kind: IntrospectedTable['kind'] }[];
  }>(
    `SELECT table_name AS name,
            CASE table_type
              WHEN 'BASE TABLE' THEN 'table'
              ELSE 'view'
            END AS kind
     FROM information_schema.tables
     WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW')
     UNION ALL
     SELECT matviewname AS name, 'materialized view' AS kind
     FROM pg_matviews
     WHERE schemaname = ?
     ORDER BY name`,
    [schema, schema],
  );

  const tables: IntrospectedTable[] = [];

  for (const tableRow of tableRows.rows) {
    const tableName = tableRow.name;

    // `information_schema` deliberately excludes materialized views. Keep its
    // privilege-aware path for tables and ordinary views, but read a materialized
    // view directly from the PostgreSQL catalogs.
    const columnRows: {
      rows: {
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
      }[];
    } =
      tableRow.kind === 'materialized view'
        ? await db.raw<{
            rows: {
              column_name: string;
              data_type: string;
              udt_name: string;
              is_nullable: string;
            }[];
          }>(
            `SELECT a.attname AS column_name,
                    CASE WHEN t.typtype = 'e' THEN 'USER-DEFINED'
                         ELSE pg_catalog.format_type(a.atttypid, a.atttypmod)
                    END AS data_type,
                    t.typname AS udt_name,
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_type t ON t.oid = a.atttypid
             WHERE c.relkind = 'm'
               AND c.relname = ?
               AND n.nspname = ?
               AND a.attnum > 0
               AND NOT a.attisdropped
             ORDER BY a.attnum`,
            [tableName, schema],
          )
        : await db.raw<{
            rows: {
              column_name: string;
              data_type: string;
              udt_name: string;
              is_nullable: string;
            }[];
          }>(
            `SELECT column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = ? AND table_schema = ?
       ORDER BY ordinal_position`,
            [tableName, schema],
          );

    // Materialized views cannot have a primary-key constraint. A valid,
    // non-partial unique index is the closest equivalent and is the index
    // PostgreSQL itself requires for concurrent refreshes.
    const pkRows =
      tableRow.kind === 'materialized view'
        ? await db.raw<{ rows: { column_name: string }[] }>(
            `WITH materialized_view AS (
               SELECT c.oid
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind = 'm' AND c.relname = ? AND n.nspname = ?
             ), unique_index AS (
               SELECT i.indexrelid, i.indrelid, i.indnkeyatts
               FROM pg_index i
               JOIN materialized_view m ON m.oid = i.indrelid
               WHERE i.indisunique
                 AND i.indisvalid
                 AND i.indpred IS NULL
                 AND i.indexprs IS NULL
               ORDER BY i.indnkeyatts, i.indexrelid
               LIMIT 1
             )
             SELECT a.attname AS column_name
             FROM unique_index i
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinal_position)
               ON TRUE
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
             WHERE key.ordinal_position <= i.indnkeyatts
             ORDER BY key.ordinal_position`,
            [tableName, schema],
          )
        : await db.raw<{ rows: { column_name: string }[] }>(
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
      ...(col.udt_name ? { udtName: col.udt_name } : {}),
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

    tables.push({ name: tableName, kind: tableRow.kind, rowCount, columns });
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
