import knex, { type Knex } from 'knex';
import type { DatabaseConfig } from '../config/config.types.js';
import type {
  DatabaseAdapter,
  DistinctValuesQuery,
  QueryCondition,
  PaginationOptions,
  SortOptions,
  QueryResult,
  RelationQuery,
  TableInfo,
  ColumnInfo,
} from './adapter.interface.js';

/**
 * Matches a bare SQL identifier (`price`, `updatedAt`) or a single double-quoted
 * identifier (`"makeEn"`) — the only two column-expression shapes
 * `InventoryResourceConfig` produces (see connector.config.example.yml). The quote
 * marks must be balanced (both present or both absent) — an unterminated quote is
 * refused rather than silently accepted. Anything else — whitespace, parentheses,
 * semicolons, quoted content, SQL keywords used as expressions — is refused too.
 */
export const SAFE_ORDER_BY_COLUMN_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*")$/;

export function isSafeOrderByColumn(column: string): boolean {
  return SAFE_ORDER_BY_COLUMN_PATTERN.test(column);
}

/**
 * Builds the raw `ORDER BY` fragment for {@link PostgresAdapter.query}.
 *
 * Defense in depth for #14461: `query-builder.ts` already restricts `sort.column`
 * to the resource's configured columns before it ever reaches this adapter, but
 * this adapter must never interpolate an arbitrary string into raw SQL regardless
 * of what a caller passes in. `sort.direction` is a TS union type narrowed to
 * exactly 'asc' | 'desc' by every caller, so it never needs the same treatment.
 */
export function buildOrderByClause(sort: SortOptions): string {
  if (!isSafeOrderByColumn(sort.column)) {
    throw new Error(`Refusing to sort by unsafe column expression: ${JSON.stringify(sort.column)}`);
  }
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  return `${sort.column} ${direction} NULLS LAST`;
}

/**
 * Default ceiling for the row count that backs `total`/`totalPages` on
 * `GET /inventory`.
 *
 * The list COUNT carries the same predicates as the data query, but — unlike
 * the data query — it cannot be short-circuited by the page's `LIMIT`, so an
 * exact `COUNT(*)` scans *every* matching row. With the search predicates
 * arriving as unindexable `ILIKE '%term%'` (see `query-builder.ts`), that made
 * every searched request pay two full scans of the merchant's production table
 * instead of one (#17420).
 *
 * Counting through a `LIMIT`ed subquery instead bounds that second scan: the
 * total stays exact for result sets up to the cap (the overwhelming majority of
 * real requests) and degrades to "at least this many" beyond it, flagged by
 * {@link QueryResult.totalIsCapped}.
 */
export const DEFAULT_COUNT_LIMIT = 1000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(schema: string | undefined, table: string): string {
  return `${quoteIdentifier(schema ?? 'public')}.${quoteIdentifier(table)}`;
}

function escapeLikePattern(value: unknown): string {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/**
 * How many matching rows the count for `pagination` may examine.
 *
 * Never below `offset + pageSize + 1`, so the cap can never hide the page being
 * served, and a caller paging past the cap still sees one more page's worth of
 * total than it has consumed — i.e. `totalPages` keeps advertising a next page
 * while one exists.
 */
export function resolveCountLimit(
  pagination: PaginationOptions,
  countLimit: number = DEFAULT_COUNT_LIMIT,
): number {
  const offset = (pagination.page - 1) * pagination.pageSize;
  return Math.max(countLimit, offset + pagination.pageSize + 1);
}

export class PostgresAdapter implements DatabaseAdapter {
  private db: Knex | null = null;
  private readonly config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.db = knex({
      client: 'pg',
      connection: {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: this.config.ssl
          ? {
              rejectUnauthorized: this.config.sslRejectUnauthorized !== false,
              ...(this.config.sslCa ? { ca: this.config.sslCa } : {}),
            }
          : false,
      },
      pool: {
        min: this.config.pool.min,
        max: this.config.pool.max,
        afterCreate: (
          conn: { query: (sql: string, cb: (err: unknown) => void) => void },
          done: (err: unknown) => void,
        ) => {
          conn.query('SET default_transaction_read_only = ON', (err) => {
            if (err) {
              done(err);
              return;
            }
            conn.query(`SET statement_timeout = ${this.config.statementTimeoutMs}`, done);
          });
        },
      },
    });

    // Warm up the connection pool — create all min connections in parallel
    // so they're ready for the first request
    await Promise.all(Array.from({ length: this.config.pool.min }, () => this.db!.raw('SELECT 1')));
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      await this.db.destroy();
      this.db = null;
    }
  }

  private getDb(): Knex {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.db;
  }

  private applyBaseFilterAndConditions(
    queryBuilder: Knex.QueryBuilder,
    db: Knex,
    conditions: QueryCondition[],
    baseFilter?: string,
  ): Knex.QueryBuilder {
    if (baseFilter) {
      queryBuilder = queryBuilder.whereRaw(`(${baseFilter})`);
    }

    // Split conditions: ILIKE conditions use OR logic within groups, AND between groups
    const searchConditions = conditions.filter((c) => c.operator === 'ILIKE');
    const filterConditions = conditions.filter((c) => c.operator !== 'ILIKE');

    for (const condition of filterConditions) {
      if (condition.operator === 'IN') {
        const sourceValues = condition.value as string[];
        queryBuilder = queryBuilder.whereRaw(
          `${condition.column} IN (${sourceValues.map(() => '?').join(', ')})`,
          sourceValues,
        );
        continue;
      }
      queryBuilder = queryBuilder.where(
        db.raw(condition.column),
        condition.operator,
        condition.value,
      );
    }

    if (searchConditions.length > 0) {
      // Group search conditions by their _group key (each group is OR'd internally, AND'd between groups)
      const groups = new Map<string, QueryCondition[]>();
      for (const sc of searchConditions) {
        const groupKey = sc._group ?? '__default';
        const existing = groups.get(groupKey);
        if (existing) {
          existing.push(sc);
        } else {
          groups.set(groupKey, [sc]);
        }
      }

      for (const groupConditions of groups.values()) {
        queryBuilder = queryBuilder.where(function (this: Knex.QueryBuilder) {
          for (let i = 0; i < groupConditions.length; i++) {
            const sc = groupConditions[i]!;
            const method = i === 0 ? 'whereRaw' : 'orWhereRaw';
            this[method](`${sc.column} ILIKE ? ESCAPE '\\'`, [`%${escapeLikePattern(sc.value)}%`]);
          }
        });
      }
    }

    return queryBuilder;
  }

  async query(
    table: string,
    conditions: QueryCondition[],
    pagination: PaginationOptions,
    sort: SortOptions,
    baseFilter?: string,
    selectColumns?: string[],
    schema?: string,
  ): Promise<QueryResult> {
    const db = this.getDb();
    const offset = (pagination.page - 1) * pagination.pageSize;

    // Build data query with specific columns
    let dataQuery: Knex.QueryBuilder = db.withSchema(schema ?? 'public').from(table);
    if (selectColumns?.length) {
      dataQuery = dataQuery.select(selectColumns.map((col) => db.raw(col)));
    }

    dataQuery = this.applyBaseFilterAndConditions(dataQuery, db, conditions, baseFilter);

    // Build the count query separately, over a LIMITed subquery so Postgres can
    // stop scanning once the cap is reached instead of walking every matching
    // row on the merchant's table (#17420).
    const countLimit = resolveCountLimit(pagination);
    let countRows: Knex.QueryBuilder = db
      .withSchema(schema ?? 'public')
      .from(table)
      .select(db.raw('1'));
    countRows = this.applyBaseFilterAndConditions(countRows, db, conditions, baseFilter);
    const countQuery = db.count('* as count').from(countRows.limit(countLimit).as('bounded_count'));

    // Run count and data queries in parallel
    const [countResult, rows] = await Promise.all([
      countQuery.first(),
      dataQuery
        .orderByRaw(buildOrderByClause(sort))
        .limit(pagination.pageSize)
        .offset(offset) as Promise<Record<string, unknown>[]>,
    ]);

    const total = Number((countResult as Record<string, unknown>)?.count ?? 0);
    return { rows, total, totalIsCapped: total >= countLimit };
  }

  async queryById(
    table: string,
    idColumn: string,
    id: string,
    baseFilter?: string,
    selectColumns?: string[],
    schema?: string,
  ): Promise<Record<string, unknown> | null> {
    const db = this.getDb();
    let queryBuilder: Knex.QueryBuilder = db.withSchema(schema ?? 'public').from(table);

    if (selectColumns?.length) {
      queryBuilder = queryBuilder.select(selectColumns.map((col) => db.raw(col)));
    }

    queryBuilder = queryBuilder.whereRaw(`${idColumn} = ?`, [id]);

    if (baseFilter) {
      queryBuilder = queryBuilder.andWhereRaw(`(${baseFilter})`);
    }

    const row = (await queryBuilder.first()) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  async queryRelation(
    query: RelationQuery,
  ): Promise<Map<string | number, Record<string, unknown>[]>> {
    const db = this.getDb();
    const result = new Map<string | number, Record<string, unknown>[]>();

    // Use a single raw query for maximum performance — avoids Knex builder overhead
    const selectParts = Object.entries(query.fields).map(([alias, col]) => `${col} as "${alias}"`);
    selectParts.push(`${query.foreignKey} as "__fk"`);

    // The startup resource probe deliberately calls this with an empty parent ID
    // list when the inventory table has no rows. Still prepare a read-only query
    // so PostgreSQL validates the relation table, fields, foreign key, and filter.
    if (query.parentIds.length === 0) {
      let sql = `SELECT ${selectParts.join(', ')} FROM ${qualifiedTable(query.schema, query.table)} WHERE FALSE`;
      if (query.filter) {
        sql += ` AND (${query.filter})`;
      }
      await db.raw(sql);
      return result;
    }

    const placeholders = query.parentIds.map(() => '?').join(', ');
    let sql = `SELECT ${selectParts.join(', ')} FROM ${qualifiedTable(query.schema, query.table)} WHERE ${query.foreignKey} IN (${placeholders})`;
    if (query.filter) {
      sql += ` AND (${query.filter})`;
    }
    if (query.orderBy) {
      sql += ` ORDER BY ${buildOrderByClause(query.orderBy)}`;
    } else {
      const [firstField] = Object.values(query.fields);
      const fallbackSorts: SortOptions[] = [
        { column: query.foreignKey, direction: 'asc' },
        ...(firstField ? [{ column: firstField, direction: 'asc' } as const] : []),
      ];
      sql += ` ORDER BY ${fallbackSorts.map(buildOrderByClause).join(', ')}`;
    }

    const rawResult = await db.raw<{ rows: Record<string, unknown>[] }>(sql, query.parentIds);
    const rows = rawResult.rows;

    for (const row of rows) {
      const fk = row['__fk'] as string | number;
      delete row['__fk'];
      const existing = result.get(fk);
      if (existing) {
        existing.push(row);
      } else {
        result.set(fk, [row]);
      }
    }

    return result;
  }

  /**
   * De-duplicates one column over a bounded slice of the table.
   *
   * The de-duplication deliberately runs inside a `LIMIT`ed subquery for the
   * same reason the list count does (#17420): a bare `SELECT DISTINCT status
   * FROM cars` has to read every row of the merchant's production table before
   * it can emit its first value. `scanLimit` keeps the diagnostic cheap and
   * predictable — this runs behind the unauthenticated, 30s-cached `/health`
   * probe — while still seeing orders of magnitude more rows than the single
   * sample row the probe maps.
   *
   * `column` and `baseFilter` are column expressions from the merchant's own
   * config file, the same trust level as the select list in {@link query}.
   * The two bounds are bound parameters, never interpolated.
   */
  async distinctValues(query: DistinctValuesQuery): Promise<unknown[]> {
    const db = this.getDb();
    const where = query.baseFilter ? ` WHERE (${query.baseFilter})` : '';
    const sampled =
      `SELECT ${query.column} AS "value" ` +
      `FROM ${qualifiedTable(query.schema, query.table)}${where} LIMIT ?`;
    const result = await db.raw<{ rows: { value: unknown }[] }>(
      `SELECT DISTINCT "value" FROM (${sampled}) AS "sampled_rows" LIMIT ?`,
      [query.scanLimit, query.limit],
    );

    return (result?.rows ?? []).map((row) => row.value);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const db = this.getDb();
      await db.raw('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async introspect(): Promise<TableInfo[]> {
    const db = this.getDb();
    const tables: TableInfo[] = [];

    const tableRows = await db.raw<{ rows: { tablename: string }[] }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );

    for (const tableRow of tableRows.rows) {
      const columnRows = await db.raw<{
        rows: { column_name: string; data_type: string; is_nullable: string }[];
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ? AND table_schema = 'public' ORDER BY ordinal_position`,
        [tableRow.tablename],
      );

      const columns: ColumnInfo[] = columnRows.rows.map((col) => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
      }));

      const countResult = await db.raw<{ rows: { count: string }[] }>(
        `SELECT count(*) as count FROM "${tableRow.tablename}"`,
      );
      const rowCount = Number(countResult.rows[0]?.count ?? 0);

      tables.push({ name: tableRow.tablename, columns, rowCount });
    }

    return tables;
  }
}
