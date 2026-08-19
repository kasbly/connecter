export interface ServerConfig {
  port: number;
  host: string;
  trustedProxies?: string;
}

export interface AuthKeyConfig {
  key: string;
  label: string;
}

export interface AuthConfig {
  apiKeys: AuthKeyConfig[];
}

export interface DatabasePoolConfig {
  min: number;
  max: number;
}

export interface DatabaseConfig {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  sslCa?: string;
  sslRejectUnauthorized?: boolean;
  statementTimeoutMs: number;
  pool: DatabasePoolConfig;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

export interface AuditConfig {
  enabled: boolean;
  filePath: string;
  maxFileSizeMB: number;
  maxFiles: number;
  retentionDays: number;
}

export interface FilterableColumnConfig {
  column: string;
  type: 'string' | 'number' | 'gte' | 'lte';
}

export const INVENTORY_STATUSES = ['ACTIVE', 'DRAFT', 'RESERVED', 'SOLD', 'EXPIRED'] as const;

export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export type StatusValuesConfig = Partial<Record<InventoryStatus, string[]>>;

export interface RelationFieldsConfig {
  [mappedName: string]: string;
}

export interface RelationOrderByConfig {
  column: string;
  direction: 'asc' | 'desc';
}

export interface RelationConfig {
  table: string;
  foreignKey: string;
  referenceKey: string;
  fields: RelationFieldsConfig;
  imageUrlField?: string;
  filter?: string;
  flatten?: string;
  orderBy?: RelationOrderByConfig;
}

export interface InventoryResourceConfig {
  table: string;
  baseFilter?: string;
  idColumn: string;
  updatedAtColumn?: string;
  fields: Record<string, string>;
  /** Values used by the source system for each Kasbly inventory status. */
  statusValues?: StatusValuesConfig;
  attributes?: Record<string, string>;
  searchableColumns?: string[];
  filterableColumns?: Record<string, FilterableColumnConfig>;
  relations?: Record<string, RelationConfig>;
}

export interface ResourcesConfig {
  inventory: InventoryResourceConfig;
}

export interface ConnectorConfig {
  version: number;
  server: ServerConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  rateLimit: RateLimitConfig;
  audit: AuditConfig;
  resources: ResourcesConfig;
}
