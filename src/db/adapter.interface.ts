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
  table: string;
  foreignKey: string;
  parentIds: (string | number)[];
  fields: Record<string, string>;
  filter?: string;
  orderBy?: SortOptions;
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
  ): Promise<QueryResult>;
  queryById(
    table: string,
    idColumn: string,
    id: string,
    baseFilter?: string,
    selectColumns?: string[],
  ): Promise<Record<string, unknown> | null>;
  queryRelation(query: RelationQuery): Promise<Map<string | number, Record<string, unknown>[]>>;
  healthCheck(): Promise<boolean>;
  introspect(): Promise<TableInfo[]>;
}
