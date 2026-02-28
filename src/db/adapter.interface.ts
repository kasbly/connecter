export interface QueryCondition {
  column: string;
  operator: '=' | '>' | '<' | '>=' | '<=' | 'ILIKE';
  value: string | number;
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
  total: number;
}

export interface RelationQuery {
  table: string;
  foreignKey: string;
  parentIds: (string | number)[];
  fields: Record<string, string>;
  filter?: string;
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
