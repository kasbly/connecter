# @kasbly/connector

A lightweight, read-only data bridge that exposes a client's existing database as a REST API for Kasbly to consume in real-time. Clients deploy the connector on their own infrastructure — Kasbly queries it remotely, never storing a local copy.

## Architecture

```
Client Infrastructure                    Kasbly Cloud
┌──────────────────────┐                ┌──────────────┐
│  PostgreSQL Database  │◄──read-only───│  Connector   │◄──HTTPS──│  Kasbly API  │
│  (client's own data)  │               │  (Fastify)   │          │  (NestJS)    │
└──────────────────────┘                └──────────────┘          └──────────────┘
```

- **Zero writes** to the client's database (enforced via `SET default_transaction_read_only = ON`)
- **No sync** — all queries are proxied in real-time
- **File-based audit log** (NDJSON) — no tables created in client's DB
- **YAML config** with environment variable interpolation

## Quick Start

### 1. Interactive Setup (recommended)

```bash
npx @kasbly/connector setup
```

The wizard connects to your database, introspects tables/columns/foreign keys, and auto-generates `connector.config.yml` + `.env` with sensible defaults.

### 2. Manual Setup

```bash
cp .env.example .env
cp connector.config.example.yml connector.config.yml
# Edit both files for your database
```

### 3. Run

```bash
# Development
npm run dev

# Production (Docker)
docker compose up -d

# Production (Node)
npm run build && npm start
```

## API Endpoints

All endpoints (except `/health`) require an `X-API-Key` header.

### `GET /health`

Returns service status and database connectivity.

```json
{ "status": "ok", "version": "1.0.0", "database": "connected", "uptime": 42 }
```

### `GET /inventory`

Paginated inventory search with filters.

| Parameter | Type | Description |
|---|---|---|
| `pageSize` | number | Items per page (1-100, default 20) |
| `page` | number | Page number (default 1) |
| `search` | string | Full-text search across searchable columns |
| `sortBy` | string | Column to sort by (default: updatedAt or id) |
| `sortDirection` | `asc` \| `desc` | Sort direction (default: desc) |
| `updatedSince` | ISO 8601 | Only items updated after this timestamp |
| `filter.<name>` | string/number | Dynamic filters defined in config |

Example:

```bash
curl -H "X-API-Key: $KEY" \
  "localhost:4000/inventory?filter.year=2024&filter.make=Hyundai&pageSize=10"
```

Response:

```json
{
  "items": [{
    "externalId": "12345",
    "title": "2024 Hyundai Sonata",
    "price": 3500,
    "currency": "KRW",
    "category": "car",
    "status": "ACTIVE",
    "images": ["https://..."],
    "attributes": { "makeEn": "Hyundai", "year": 2024, "features": ["ABS", "Airbag"] },
    "updatedAt": "2026-02-28T10:00:00.000Z"
  }],
  "total": 2190,
  "page": 1,
  "pageSize": 10,
  "totalPages": 219
}
```

### `GET /inventory/:id`

Single item by ID with all relations.

### `GET /audit-log`

Query the NDJSON audit log (paginated, filterable by `since`).

## Configuration

### `connector.config.yml`

```yaml
version: 1

server:
  port: 4000
  host: "0.0.0.0"

auth:
  apiKeys:
    - key: "${CONNECTOR_API_KEY}"    # Interpolated from .env
      label: "kasbly-production"

database:
  type: postgres
  host: "${DB_HOST}"
  port: 5432
  database: "${DB_NAME}"
  user: "${DB_USER}"
  password: "${DB_PASSWORD}"
  ssl: false
  pool: { min: 2, max: 10 }

rateLimit:
  maxRequests: 100
  windowSeconds: 60

audit:
  enabled: true
  filePath: "./logs/audit.log"
  maxFileSizeMB: 50
  retentionDays: 90

resources:
  inventory:
    table: "Car"
    baseFilter: 'published = true AND "deletedAt" IS NULL'
    idColumn: "id"
    updatedAtColumn: '"updatedAt"'

    # Standard fields mapped to the Kasbly inventory schema
    fields:
      externalId: "id"
      title: "title"
      price: "price"
      currency: "'KRW'"          # Literal value (single quotes)
      category: "'car'"

    # Additional columns exposed as key-value attributes
    attributes:
      makeEn: '"makeEn"'         # Quoted = case-sensitive column
      year: "year"               # Unquoted = lowercase column
      fuelType: '"fuelType"'

    # Text columns for ILIKE search (OR logic across columns)
    searchableColumns:
      - "title"
      - '"makeEn"'
      - '"modelEn"'

    # Filters available via ?filter.<name>=<value>
    filterableColumns:
      year: { column: "year", type: "number" }
      make: { column: '"makeEn"', type: "string" }
      fuelType: { column: '"fuelType"', type: "string" }
      minPrice: { column: "price", type: "gte" }
      maxPrice: { column: "price", type: "lte" }

    # Related tables fetched per item
    relations:
      images:
        table: "Image"
        foreignKey: '"carId"'
        referenceKey: "id"
        fields: { url: "url", type: "type" }
        imageUrlField: "url"                      # Extracts URLs into images[]
        filter: "type = 'gallery' OR type = 'featured'"
      features:
        table: "CarFeatures"
        foreignKey: '"carId"'
        referenceKey: "id"
        fields: { name: '"featureName"' }
        flatten: "name"                           # Flattens to string[]
```

### Column Name Quoting

| Syntax | Meaning | Example |
|---|---|---|
| `year` | Lowercase column | `SELECT year ...` |
| `'"makeEn"'` | Case-sensitive column | `SELECT "makeEn" ...` |
| `"'KRW'"` | Literal string value | Returns `"KRW"` for every row |

### Filter Types

| Type | Operator | Use case |
|---|---|---|
| `string` | `=` | Exact match (make, color, fuelType) |
| `number` | `=` | Exact numeric match (year) |
| `gte` | `>=` | Range lower bound (minPrice, minYear) |
| `lte` | `<=` | Range upper bound (maxPrice, maxYear) |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DB_HOST` | Yes | Database hostname |
| `DB_NAME` | Yes | Database name |
| `DB_USER` | Yes | Database username |
| `DB_PASSWORD` | Yes | Database password |
| `CONNECTOR_API_KEY` | Yes | API key shared with Kasbly |
| `CONFIG_PATH` | No | Config file path (default: `./connector.config.yml`) |

## Docker Deployment

```bash
docker compose up -d
```

The `docker-compose.yml` mounts `connector.config.yml` as read-only and persists audit logs in a volume. The health check hits `GET /health` every 30 seconds.

## Security

- **Read-only database access** — enforced at the connection pool level
- **API key authentication** — timing-safe comparison on every request (except `/health`)
- **Rate limiting** — configurable per-IP request limits
- **No SQL/stack trace exposure** — errors return generic messages to clients
- **Audit trail** — every API request logged with timestamp, method, query, response time, and client IP

## Development

```bash
# Install dependencies (from monorepo root)
pnpm install

# Run tests
pnpm --filter @kasbly/connector test

# Dev server with hot reload
pnpm --filter @kasbly/connector dev
```

## Project Structure

```
src/
├── config/          Config loading, Zod validation, env interpolation
├── db/              Database adapter interface + PostgreSQL implementation
├── mapping/         Row-to-item mapping, query building, column extraction
├── auth/            API key guard (Fastify preHandler hook)
├── audit/           NDJSON file-based audit logger
├── middleware/       Rate limiter config
├── routes/          Fastify route handlers (health, inventory, audit-log)
├── setup/           Interactive CLI wizard (introspect, suggest, generate)
├── server.ts        Fastify app builder
└── index.ts         Entry point
```
