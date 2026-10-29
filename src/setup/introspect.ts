import knex, { type Knex } from 'knex';

export const SETUP_STATEMENT_TIMEOUT_MS = 10_000;

export interface IntrospectedTable {
  name: string;
  kind: 'table' | 'view' | 'materialized view';
  /**
   * Planner estimate of live rows (`pg_class.reltuples`, or the sum of
   * partition-leaf estimates). Null when that estimate is unknown: the
   * relation was never analyzed (`reltuples` is -1), it is a view (ANALYZE
   * does not record one), or it is a partitioned parent whose leaves are not
   * a known estimate. 0 means analyzed and empty — not a stand-in for unknown.
   */
  rowCount: number | null;
  columns: IntrospectedColumn[];
}

interface RelationEstimateRow {
  estimate: string | number | null;
  partitioned: boolean | null;
  child_count: number | string | null;
  child_unknown: boolean | null;
  child_estimate: string | number | null;
}

/** `reltuples` of -1 (and any non-finite value) means the planner has no estimate. */
function readRelEstimate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function readChildCount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Views have no `reltuples` estimate. Partitioned parents often stay at 0
 * until ANALYZE even when the leaves hold the catalog; prefer the sum of
 * leaf estimates, and never turn an unknown leaf (`-1`) into 0.
 */
export function resolveIntrospectedRowCount(
  kind: IntrospectedTable['kind'],
  row: Partial<RelationEstimateRow> | undefined,
): number | null {
  if (kind === 'view') return null;

  const own = readRelEstimate(row?.estimate);
  if (!row || row.partitioned !== true) return own;

  const childCount = readChildCount(row.child_count);
  if (childCount > 0 && row.child_unknown !== true) {
    return readRelEstimate(row.child_estimate);
  }

  // A positive parent estimate was written by ANALYZE. 0/-1 was not.
  return own !== null && own > 0 ? own : null;
}

/** Choice label for the inventory picker and the no-FK relation picker. */
export function formatSetupTableChoice(table: IntrospectedTable): string {
  const count =
    table.rowCount === null ? 'row count unavailable' : `${table.rowCount.toLocaleString()} rows`;
  return `${table.name} (${table.kind}, ${count})`;
}

/**
 * Descending known estimates. Unknown counts sort first so the highlighted
 * default (the first choice) is not a tiny analyzed lookup sitting above an
 * unanalyzed catalog or a view.
 */
export function compareSetupTablesByRowCount(a: IntrospectedTable, b: IntrospectedTable): number {
  if (a.rowCount === null || b.rowCount === null) {
    if (a.rowCount === b.rowCount) return 0;
    return a.rowCount === null ? -1 : 1;
  }
  return b.rowCount - a.rowCount;
}

export interface IntrospectedColumn {
  name: string;
  type: string;
  /** PostgreSQL's underlying type name (also present for non-enum extension types). */
  udtName?: string;
  /** True only when PostgreSQL's type catalog identifies a scalar enum. */
  isEnum?: boolean;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface ForeignKeyInfo {
  /** The constraint this column pair belongs to. Composite foreign keys report
   *  one row per column pair, all sharing this name, so callers can regroup them. */
  constraintName: string;
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
       AND NOT EXISTS (
         SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = tables.table_name AND n.nspname = tables.table_schema
           AND c.relispartition
       )
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
        is_enum?: boolean;
        is_nullable: string;
      }[];
    } =
      tableRow.kind === 'materialized view'
        ? await db.raw<{
            rows: {
              column_name: string;
              data_type: string;
              udt_name: string;
              is_enum: boolean;
              is_nullable: string;
            }[];
          }>(
            `SELECT a.attname AS column_name,
                    CASE WHEN t.typtype = 'e' THEN 'USER-DEFINED'
                         ELSE pg_catalog.format_type(a.atttypid, NULL)
                    END AS data_type,
                    t.typname AS udt_name,
                    (t.typtype = 'e') AS is_enum,
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
              is_enum: boolean;
              is_nullable: string;
            }[];
          }>(
            `SELECT column_name, data_type, udt_name, is_nullable,
              EXISTS (
                SELECT 1 FROM pg_catalog.pg_type t
                JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                WHERE t.typname = columns.udt_name AND n.nspname = columns.udt_schema
                  AND t.typtype = 'e'
              ) AS is_enum
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
               SELECT i.indexrelid, i.indrelid, i.indnkeyatts, i.indkey
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
            // information_schema.table_constraints hides keys from SELECT-only
            // roles. Catalogs retain them without requiring write privileges.
            `SELECT a.attname AS column_name
             FROM pg_constraint c
             JOIN pg_class cl ON cl.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = cl.relnamespace
             JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinal_position)
               ON TRUE
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
             WHERE c.contype = 'p'
               AND cl.relname = ?
               AND n.nspname = ?
             ORDER BY key.ordinal_position`,
            [tableName, schema],
          );
    const pkColumns = new Set(pkRows.rows.map((r) => r.column_name));

    const columns: IntrospectedColumn[] = columnRows.rows.map((col) => ({
      name: col.column_name,
      type: col.data_type,
      ...(col.udt_name ? { udtName: col.udt_name } : {}),
      ...(col.is_enum === true ? { isEnum: true } : {}),
      nullable: col.is_nullable === 'YES',
      isPrimaryKey: pkColumns.has(col.column_name),
    }));

    // Planner estimate only — never COUNT(*) a merchant table. -1 is unknown.
    // Partition parents keep reltuples at 0 until ANALYZE; sum leaf estimates.
    const countResult = await db.raw<{ rows: RelationEstimateRow[] }>(
      `SELECT c.reltuples::bigint AS estimate,
              (c.relkind = 'p') AS partitioned,
              parts.child_count,
              parts.child_unknown,
              parts.child_estimate
       FROM pg_class c
       LEFT JOIN LATERAL (
         WITH RECURSIVE partition_tree AS (
           SELECT child.oid, child.reltuples, child.relkind
           FROM pg_inherits AS inherited
           JOIN pg_class AS child ON child.oid = inherited.inhrelid
           WHERE inherited.inhparent = c.oid
           UNION ALL
           SELECT child.oid, child.reltuples, child.relkind
           FROM partition_tree AS parent
           JOIN pg_inherits AS inherited ON inherited.inhparent = parent.oid
           JOIN pg_class AS child ON child.oid = inherited.inhrelid
         )
         SELECT (COUNT(*) FILTER (WHERE relkind <> 'p'))::int AS child_count,
                COALESCE(
                  BOOL_OR(reltuples < 0) FILTER (WHERE relkind <> 'p'),
                  FALSE
                ) AS child_unknown,
                COALESCE(
                  SUM(reltuples) FILTER (WHERE relkind <> 'p' AND reltuples >= 0),
                  0
                )::bigint AS child_estimate
         FROM partition_tree
       ) AS parts ON TRUE
       WHERE c.relname = ? AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ?)`,
      [tableName, schema],
    );
    const rowCount = resolveIntrospectedRowCount(tableRow.kind, countResult.rows[0]);

    tables.push({ name: tableName, kind: tableRow.kind, rowCount, columns });
  }

  return tables;
}

async function introspectForeignKeys(db: Knex, schema: string): Promise<ForeignKeyInfo[]> {
  // Read from the PostgreSQL catalogs instead of information_schema. A foreign key's
  // local and referenced columns are paired positionally in pg_constraint.conkey /
  // confkey; information_schema.key_column_usage / constraint_column_usage carry no
  // ordinal position and are only joined by constraint name, which is a cross product
  // for composite keys (every local column pairs with every referenced column) and is
  // outright wrong when two unrelated tables share a hand-written constraint name
  // (PostgreSQL only enforces FK constraint-name uniqueness per table, not per schema).
  // Setup only offers tables in the selected schema. A same-named parent in
  // another schema is a different relation and must not join this inventory.
  const fkRows = await db.raw<{
    rows: {
      constraint_name: string;
      from_table: string;
      from_column: string;
      to_table: string;
      to_column: string;
    }[];
  }>(
    `SELECT
       c.conname AS constraint_name,
       cl.relname AS from_table,
       a.attname AS from_column,
       fcl.relname AS to_table,
       fa.attname AS to_column
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_class fcl ON fcl.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON TRUE
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
     JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
     WHERE c.contype = 'f'
       AND c.conparentid = 0
       AND n.nspname = ?
       AND fcl.relnamespace = cl.relnamespace
     ORDER BY cl.relname, c.conname, k.ord`,
    [schema],
  );

  return fkRows.rows.map((row) => ({
    constraintName: row.constraint_name,
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toTable: row.to_table,
    toColumn: row.to_column,
  }));
}
