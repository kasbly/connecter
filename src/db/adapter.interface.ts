export interface QueryCondition {
  column: string;
  operator: '=' | '>' | '<' | '>=' | '<=' | 'ILIKE' | 'IN';
  value: string | number | string[];
  /** Optional group key — search conditions with the same group are OR'd, different groups are AND'd */
  _group?: string;
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
}

export interface SortOptions {
  column: string;
  direction: 'asc' | 'desc';
  /**
   * Unique column appended as a final `DESC` sort key so a page is taken from a
   * totally ordered result set. Without it, rows sharing the `column` value have
   * no defined order between two `LIMIT`/`OFFSET` requests, so page 2 can repeat
   * page 1's rows and leave others unreachable (#24914). Ignored when it is the
   * sort column itself, which is already unique.
   */
  tiebreaker?: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /**
   * Number of matching rows. Exact unless `totalIsCapped` is true, in which
   * case it is a lower bound — the adapter stopped counting at its cap instead
   * of scanning the whole merchant table (#17420).
   */
  total: number;
  /** True when `total` is a lower bound rather than an exact count. */
  totalIsCapped?: boolean;
}

export interface RelationQuery {
  schema?: string;
  table: string;
  foreignKey: string;
  parentIds: (string | number)[];
  fields: Record<string, string>;
  filter?: string;
  orderBy?: SortOptions;
}

export interface DistinctValuesQuery {
  schema?: string;
  table: string;
  /** Column expression from the resource mapping, e.g. `status` or `"listingStatus"`. */
  column: string;
  /** Hard ceiling on how many distinct values are returned. */
  limit: number;
  /** Hard ceiling on how many rows the scan may read before de-duplicating. */
  scanLimit: number;
  baseFilter?: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query(
    table: string,
    conditions: QueryCondition[],
    pagination: PaginationOptions,
    sort: SortOptions,
    baseFilter?: string,
    selectColumns?: string[],
    schema?: string,
  ): Promise<QueryResult>;
  queryById(
    table: string,
    idColumn: string,
    id: string,
    baseFilter?: string,
    selectColumns?: string[],
    schema?: string,
  ): Promise<Record<string, unknown> | null>;
  queryRelation(query: RelationQuery): Promise<Map<string | number, Record<string, unknown>[]>>;
  /**
   * Bounded `SELECT DISTINCT` over one column, used by the inventory resource
   * probe to report source status values the merchant has not mapped
   * (#23293). Optional: a caller must fall back to the rows it already sampled
   * when an adapter cannot answer it.
   */
  distinctValues?(query: DistinctValuesQuery): Promise<unknown[]>;
  healthCheck(): Promise<boolean>;
  introspect(): Promise<TableInfo[]>;
}
