import knex, { type Knex } from 'knex';
import type { DatabaseConfig } from '../config/config.types.js';
import type {
  DatabaseAdapter,
  QueryCondition,
  PaginationOptions,
  SortOptions,
  QueryResult,
  RelationQuery,
  TableInfo,
  ColumnInfo,
} from './adapter.interface.js';

export class PostgresAdapter implements DatabaseAdapter {
  private db: Knex | null = null;
  private readonly config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Ensure pool min is high enough for parallel queries (data + count + relations)
    const poolMin = Math.max(this.config.pool.min, 5);
    const poolMax = Math.max(this.config.pool.max, poolMin);

    this.db = knex({
      client: 'pg',
      connection: {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      },
      pool: {
        min: poolMin,
        max: poolMax,
        afterCreate: (conn: { query: (sql: string, cb: (err: unknown) => void) => void }, done: (err: unknown) => void) => {
          conn.query('SET default_transaction_read_only = ON', (err) => {
            done(err);
          });
        },
      },
    });

    // Warm up the connection pool — create all min connections in parallel
    // so they're ready for the first request
    await Promise.all(
      Array.from({ length: poolMin }, () => this.db!.raw('SELECT 1')),
    );
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
      queryBuilder = queryBuilder.whereRaw(baseFilter);
    }

    // Split conditions: ILIKE conditions use OR logic, everything else uses AND
    const searchConditions = conditions.filter((c) => c.operator === 'ILIKE');
    const filterConditions = conditions.filter((c) => c.operator !== 'ILIKE');

    for (const condition of filterConditions) {
      queryBuilder = queryBuilder.where(
        db.raw(condition.column),
        condition.operator,
        condition.value,
      );
    }

    if (searchConditions.length > 0) {
      queryBuilder = queryBuilder.where(function (this: Knex.QueryBuilder) {
        for (let i = 0; i < searchConditions.length; i++) {
          const sc = searchConditions[i]!;
          const method = i === 0 ? 'whereRaw' : 'orWhereRaw';
          this[method](`${sc.column} ILIKE ?`, [`%${String(sc.value)}%`]);
        }
      });
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
  ): Promise<QueryResult> {
    const db = this.getDb();
    const offset = (pagination.page - 1) * pagination.pageSize;

    // Build data query with specific columns
    let dataQuery = selectColumns?.length
      ? db(table).select(selectColumns.map((col) => db.raw(col)))
      : db(table);

    dataQuery = this.applyBaseFilterAndConditions(dataQuery, db, conditions, baseFilter);

    // Build count query separately
    let countQuery = db(table).count('* as count');
    countQuery = this.applyBaseFilterAndConditions(countQuery, db, conditions, baseFilter);

    // Run count and data queries in parallel
    const [countResult, rows] = await Promise.all([
      countQuery.first(),
      dataQuery
        .orderByRaw(`${sort.column} ${sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`)
        .limit(pagination.pageSize)
        .offset(offset) as Promise<Record<string, unknown>[]>,
    ]);

    const total = Number((countResult as Record<string, unknown>)?.count ?? 0);
    return { rows, total };
  }

  async queryById(
    table: string,
    idColumn: string,
    id: string,
    baseFilter?: string,
    selectColumns?: string[],
  ): Promise<Record<string, unknown> | null> {
    const db = this.getDb();
    let queryBuilder = selectColumns?.length
      ? db(table).select(selectColumns.map((col) => db.raw(col))).whereRaw(`${idColumn} = ?`, [id])
      : db(table).whereRaw(`${idColumn} = ?`, [id]);

    if (baseFilter) {
      queryBuilder = queryBuilder.whereRaw(baseFilter);
    }

    const row = await queryBuilder.first() as Record<string, unknown> | undefined;
    return row ?? null;
  }

  async queryRelation(
    query: RelationQuery,
  ): Promise<Map<string | number, Record<string, unknown>[]>> {
    const db = this.getDb();
    const result = new Map<string | number, Record<string, unknown>[]>();

    if (query.parentIds.length === 0) {
      return result;
    }

    // Use a single raw query for maximum performance — avoids Knex builder overhead
    const selectParts = Object.entries(query.fields).map(
      ([alias, col]) => `${col} as "${alias}"`,
    );
    selectParts.push(`${query.foreignKey} as "__fk"`);

    const placeholders = query.parentIds.map(() => '?').join(', ');
    let sql = `SELECT ${selectParts.join(', ')} FROM "${query.table}" WHERE ${query.foreignKey} IN (${placeholders})`;
    if (query.filter) {
      sql += ` AND (${query.filter})`;
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
