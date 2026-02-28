import { z } from 'zod';

const serverSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
});

const authKeySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});

const authSchema = z.object({
  apiKeys: z.array(authKeySchema).min(1),
});

const databasePoolSchema = z.object({
  min: z.number().int().min(0).default(2),
  max: z.number().int().min(1).default(10),
});

const databaseSchema = z.object({
  type: z.literal('postgres'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  ssl: z.boolean().default(false),
  pool: databasePoolSchema.default({ min: 2, max: 10 }),
});

const rateLimitSchema = z.object({
  maxRequests: z.number().int().min(1).default(100),
  windowSeconds: z.number().int().min(1).default(60),
});

const auditSchema = z.object({
  enabled: z.boolean().default(true),
  filePath: z.string().default('./logs/audit.log'),
  maxFileSizeMB: z.number().min(1).default(50),
  retentionDays: z.number().int().min(1).default(90),
});

const filterableColumnSchema = z.object({
  column: z.string().min(1),
  type: z.enum(['string', 'number', 'gte', 'lte']),
});

const relationSchema = z.object({
  table: z.string().min(1),
  foreignKey: z.string().min(1),
  referenceKey: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  imageUrlField: z.string().optional(),
  filter: z.string().optional(),
  flatten: z.string().optional(),
});

const inventoryResourceSchema = z.object({
  table: z.string().min(1),
  baseFilter: z.string().optional(),
  idColumn: z.string().min(1),
  updatedAtColumn: z.string().optional(),
  fields: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), z.string()).optional(),
  searchableColumns: z.array(z.string()).optional(),
  filterableColumns: z.record(z.string(), filterableColumnSchema).optional(),
  relations: z.record(z.string(), relationSchema).optional(),
});

const resourcesSchema = z.object({
  inventory: inventoryResourceSchema,
});

export const connectorConfigSchema = z.object({
  version: z.number().int().min(1),
  server: serverSchema.default({ port: 4000, host: '0.0.0.0' }),
  auth: authSchema,
  database: databaseSchema,
  rateLimit: rateLimitSchema.default({ maxRequests: 100, windowSeconds: 60 }),
  audit: auditSchema.default({
    enabled: true,
    filePath: './logs/audit.log',
    maxFileSizeMB: 50,
    retentionDays: 90,
  }),
  resources: resourcesSchema,
});
