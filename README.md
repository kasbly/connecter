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

### 1. Clone and run the interactive setup (recommended)

```bash
git clone https://github.com/kasbly/connecter.git
cd connecter
npm ci
npm run setup
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

# Production (Docker, HTTPS)
# Before starting: set CONNECTOR_DOMAIN in .env and point that DNS name at this host.
docker compose up -d

# Verify the public, TLS-protected endpoint
curl -fsS https://"$CONNECTOR_DOMAIN"/health

# Production (Node)
npm run build && npm start
```

## Scripts

Run these commands from the connector directory:

```bash
npm run dev        # Start the dev server
npm run build      # Compile TypeScript
npm start          # Start the built server
npm run setup      # Launch the interactive setup wizard
npm run validate   # Validate config and probe the live inventory mapping
npm run typecheck  # Run `tsc --noEmit`
npm run lint       # Run ESLint
npm test           # Run the Vitest suite
```

## API Endpoints

All endpoints (except `/health`) require an `X-API-Key` header.

### `GET /health`

Returns service status, database connectivity, whether the configured inventory
resource can be queried, and audit-log persistence. The resource check is cached
briefly to keep health checks lightweight. A failed mapping check or an enabled audit
log that cannot write, rotate, or prune returns HTTP 503 with an operator-facing error.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "database": "connected",
  "resources": "ok",
  "audit": "ok",
  "uptime": 42
}
```

### `GET /inventory`

Paginated inventory search with filters.

| Parameter       | Type            | Description                                  |
| --------------- | --------------- | -------------------------------------------- |
| `pageSize`      | number          | Items per page (1-100, default 20)           |
| `page`          | number          | Page number (default 1)                      |
| `search`        | string          | Full-text search across searchable columns   |
| `sortBy`        | string          | Column to sort by (default: updatedAt or id) |
| `sortDirection` | `asc` \| `desc` | Sort direction (default: desc)               |
| `updatedSince`  | ISO 8601        | Only items updated after this timestamp      |
| `filter.<name>` | string/number   | Dynamic filters defined in config            |

Example:

```bash
curl -H "X-API-Key: $KEY" \
  "localhost:4000/inventory?filter.year=2024&filter.make=Hyundai&pageSize=10"
```

Response:

```json
{
  "items": [
    {
      "externalId": "12345",
      "title": "2024 Hyundai Sonata",
      "description": "Low-mileage sedan with a full service history",
      "price": 3500,
      "currency": "KRW",
      "category": "car",
      "status": "ACTIVE",
      "images": ["https://..."],
      "attributes": { "makeEn": "Hyundai", "year": 2024, "features": ["ABS", "Airbag"] },
      "updatedAt": "2026-02-28T10:00:00.000Z"
    }
  ],
  "total": 1000,
  "totalIsCapped": true,
  "page": 1,
  "pageSize": 10,
  "totalPages": 100
}
```

`total` is counted through a `LIMIT`ed subquery so a list request never pays a
full extra scan of your table just to produce a page count. It is exact for
result sets up to 1000 rows (`"totalIsCapped": false`); past that it stops at
the cap and reports `"totalIsCapped": true`, meaning "at least this many" —
render it as `1000+` rather than as an exact figure. The cap is always lifted
far enough to cover the page being requested, so deep pagination still works.

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
  host: '0.0.0.0'
  # trustedProxies: '10.0.0.0/8' # Optional — only if run behind your own reverse proxy

auth:
  apiKeys:
    - key: '${CONNECTOR_API_KEY}' # Interpolated from .env
      label: 'kasbly-production'

database:
  type: postgres
  host: '${DB_HOST}'
  port: 5432
  database: '${DB_NAME}'
  user: '${DB_USER}'
  password: '${DB_PASSWORD}'
  ssl: false # Set true to enable TLS with certificate verification
  # sslCa: '${DB_SSL_CA}' # Optional PEM CA certificate/bundle for a private CA
  # sslRejectUnauthorized: true # Default; false disables server authentication
  statementTimeoutMs: 10000 # Cancels merchant DB queries that exceed 10 seconds
  pool: { min: 2, max: 10 }

rateLimit:
  maxRequests: 100
  windowSeconds: 60

audit:
  enabled: true
  filePath: './logs/audit.log'
  maxFileSizeMB: 50
  maxFiles: 10
  retentionDays: 90

# Audit history lasts the smaller of retentionDays and the time traffic fills
# (maxFiles + 1) x maxFileSizeMB. Raise maxFiles or maxFileSizeMB for busy connectors.

resources:
  inventory:
    # PostgreSQL schema. Omit to use public.
    schema: 'public'
    table: 'Car'
    baseFilter: 'published = true AND "deletedAt" IS NULL'
    idColumn: 'id'
    updatedAtColumn: '"updatedAt"'

    # Standard fields mapped to the Kasbly inventory schema
    fields:
      externalId: 'id'
      title: 'title'
      description: 'description'
      price: 'price'
      currency: "'KRW'" # Literal value (single quotes)
      category: "'car'"
      status: 'status' # Leave unmapped only when every listing is Active
      # Optional: one URL, a PostgreSQL text[] value, or a JSON array of URL strings.
      # Row images come first, followed by images from relations below.
      images: 'image_urls'

    # Source-system values for Kasbly's accepted status tokens.
    # Defaults accept ACTIVE, DRAFT, RESERVED, SOLD, and EXPIRED (case-insensitive).
    statusValues:
      ACTIVE: ['active', 'for_sale']
      DRAFT: ['draft']
      RESERVED: ['reserved']
      SOLD: ['sold']
      EXPIRED: ['expired']

    # Additional columns exposed as key-value attributes
    attributes:
      makeEn: '"makeEn"' # Quoted = case-sensitive column
      year: 'year' # Unquoted = lowercase column
      fuelType: '"fuelType"'

    # Text columns for ILIKE search (OR logic across columns)
    searchableColumns:
      - 'title'
      - '"makeEn"'
      - '"modelEn"'

    # Filters available via ?filter.<name>=<value>
    filterableColumns:
      status: { column: 'status', type: 'string' }
      year: { column: 'year', type: 'number' }
      minYear: { column: 'year', type: 'gte' }
      maxYear: { column: 'year', type: 'lte' }
      make: { column: '"makeEn"', type: 'string' }
      fuelType: { column: '"fuelType"', type: 'string' }
      minPrice: { column: 'price', type: 'gte' }
      maxPrice: { column: 'price', type: 'lte' }

    # Related tables fetched per item
    relations:
      images:
        schema: 'public'
        table: 'Image'
        foreignKey: '"carId"'
        referenceKey: 'id'
        fields: { url: 'url', type: 'type' }
        imageUrlField: 'url' # Extracts URLs into images[]
        filter: "type = 'gallery' OR type = 'featured'"
        orderBy: { column: 'position', direction: 'asc' } # Stable image order
      features:
        schema: 'public'
        table: 'CarFeatures'
        foreignKey: '"carId"'
        referenceKey: 'id'
        fields: { name: '"featureName"' }
        flatten: 'name' # Flattens to string[]
```

### Database TLS

When `database.ssl` is `true`, the connector verifies the Postgres server certificate and
hostname by default. Publicly trusted certificates need no additional configuration. For a
private CA or self-signed deployment, provide its PEM certificate or bundle through
`database.sslCa` (for example, `${DB_SSL_CA}`).

`database.sslRejectUnauthorized: false` is an explicit compatibility escape hatch that disables
server authentication. It makes the connection vulnerable to interception and should only be used
temporarily while a valid CA bundle is configured.

### Column Name Quoting

| Syntax       | Meaning               | Example                       |
| ------------ | --------------------- | ----------------------------- |
| `year`       | Lowercase column      | `SELECT year ...`             |
| `'"makeEn"'` | Case-sensitive column | `SELECT "makeEn" ...`         |
| `"'KRW'"`    | Literal string value  | Returns `"KRW"` for every row |

### Inventory Status Mapping

Kasbly accepts these inventory status tokens: `ACTIVE`, `DRAFT`, `RESERVED`, `SOLD`, and
`EXPIRED`. Map the source status column in `fields.status`, then use `statusValues` to translate
the source system's vocabulary. The defaults recognize each token in either uppercase or lowercase;
add source-specific values such as `for_sale`, `under_offer`, or `backorder` to the corresponding
list. When `fields.status` is not mapped, the connector logs a startup warning and reports every
listing as `ACTIVE`.

Status filters use the same mapping: `filter.status=SOLD` queries every source value configured
under `statusValues.SOLD`.

### Filter Types

| Type     | Operator | Use case                              |
| -------- | -------- | ------------------------------------- |
| `string` | `=`      | Exact match (make, color, fuelType)   |
| `number` | `=`      | Exact numeric match (year)            |
| `gte`    | `>=`     | Range lower bound (minPrice, minYear) |
| `lte`    | `<=`     | Range upper bound (maxPrice, maxYear) |

## Environment Variables

| Variable            | Required | Description                                                   |
| ------------------- | -------- | ------------------------------------------------------------- |
| `DB_HOST`           | Yes      | Database hostname                                             |
| `DB_NAME`           | Yes      | Database name                                                 |
| `DB_USER`           | Yes      | Database username                                             |
| `DB_PASSWORD`       | Yes      | Database password                                             |
| `DB_SSL_CA`         | No       | PEM CA bundle referenced by `database.sslCa` for a private CA |
| `CONNECTOR_API_KEY` | Yes      | API key shared with Kasbly                                    |
| `CONNECTOR_DOMAIN`  | Docker   | Public DNS name used by the bundled HTTPS proxy               |
| `CONFIG_PATH`       | No       | Config file path (default: `./connector.config.yml`)          |

## Docker HTTPS Deployment

The bundled Compose deployment is the supported production path. It includes Caddy, which
terminates HTTPS, automatically obtains and renews a publicly trusted certificate, and proxies
requests to the connector over an internal Docker network. The connector itself is not exposed on
the host, so Kasbly must use the HTTPS URL.

1. Create a public DNS `A` (and, when applicable, `AAAA`) record for the hostname you will use,
   pointing to this server. Allow inbound TCP ports 80 and 443; Caddy uses port 80 to complete the
   initial certificate challenge and redirects users to HTTPS.
2. Set `CONNECTOR_DOMAIN` in `.env` to that hostname, for example
   `CONNECTOR_DOMAIN=connector.merchant.example`.
3. Keep `server.trustedProxies: '172.30.0.2'` in `connector.config.yml`. That is the fixed address
   of the bundled Caddy container, so client IP forwarding remains trusted only from the proxy.
4. Start the deployment and verify the exact URL to enter in Kasbly Cloud:

```bash
docker compose up -d
curl -fsS https://"$CONNECTOR_DOMAIN"/health
```

The response must report a healthy connector before using the URL in Kasbly. Caddy stores its
certificate state in named Docker volumes, so renewal survives container replacement. The
`docker-compose.yml` mounts `connector.config.yml` as read-only and persists audit logs in a
volume; its internal health check hits `GET /health` every 30 seconds.

## Security

- **Bounded read-only database access** — read-only mode and a configurable query timeout are enforced at the connection pool level
- **API key authentication** — timing-safe comparison on every request (except `/health`)
- **Rate limiting** — configurable per-IP request limits, keyed on the real client IP (see below)
- **No SQL/stack trace exposure** — errors return generic messages to clients
- **Audit trail** — every API request logged with timestamp, method, query, response time, and client IP

### Client IP and trusted proxies

The connector does not trust `X-Forwarded-For`/`X-Real-IP` headers unless
`server.trustedProxies` is set. The bundled Docker HTTPS deployment sets this to Caddy's fixed
internal address (`172.30.0.2`), so rate limiting and audit logging use the real client IP only for
requests that Caddy forwarded. If you use a different proxy topology, replace that value with only
the direct proxy IPs/CIDRs; do not use a broad network range and never trust forwarded headers for
a directly exposed connector.

## Development

```bash
# Install dependencies
npm ci

# Run tests
npm test

# Dev server with hot reload
npm run dev
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
