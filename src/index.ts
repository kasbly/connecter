import 'dotenv/config';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ConnectorConfig } from './config/config.types.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { loadConfig } from './config/config.loader.js';
import { createDatabaseAdapter } from './db/adapter.factory.js';
import { createResourceHealthCheck } from './routes/health.route.js';
import { buildApp, type AppDeps } from './server.js';

const DEFAULT_CONFIG_PATH = resolve('connector.config.yml');
const CONFIG_PATH = process.env['CONFIG_PATH'] ?? DEFAULT_CONFIG_PATH;

/**
 * Validates that the config file path exists and is accessible.
 *
 * @param path - Path to the connector config file
 * @throws {Error} If the file does not exist
 */
export async function validateConfigPath(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `CONFIG_PATH "${path}" does not exist. ` +
        'Run `npm run setup` to generate one, copy connector.config.example.yml, or set the CONFIG_PATH environment variable to point to a valid connector.config.yml file.',
    );
  }
}

interface StartupDependencies {
  validateConfigPath(path: string): Promise<void>;
  loadConfig(path: string): ConnectorConfig;
  createDatabaseAdapter(config: ConnectorConfig['database']): DatabaseAdapter;
  buildApp(deps: AppDeps): Promise<FastifyInstance>;
}

const defaultStartupDependencies: StartupDependencies = {
  validateConfigPath,
  loadConfig,
  createDatabaseAdapter,
  buildApp,
};

export interface StartConnectorOptions {
  configPath?: string;
  dependencies?: Partial<StartupDependencies>;
}

/**
 * Starts the HTTP diagnostics surface as soon as configuration is valid.
 * Database and mapping readiness then recover asynchronously and are reported
 * by `/health`; inventory reads remain unavailable until both are ready.
 */
export async function startConnector(
  options: StartConnectorOptions = {},
): Promise<FastifyInstance> {
  const configPath = options.configPath ?? CONFIG_PATH;
  const dependencies: StartupDependencies = {
    ...defaultStartupDependencies,
    ...options.dependencies,
  };

  console.log(`Loading config from ${configPath}`);
  await dependencies.validateConfigPath(configPath);
  const config = dependencies.loadConfig(configPath);

  const dbAdapter = dependencies.createDatabaseAdapter(config.database);
  const getResourceHealth = createResourceHealthCheck(dbAdapter, config.resources.inventory);
  const app = await dependencies.buildApp({ config, dbAdapter, getResourceHealth });

  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(`Kasbly Connector listening on ${config.server.host}:${config.server.port}`);

  console.log(
    `Connecting to ${config.database.type} at ${config.database.host}:${config.database.port}...`,
  );

  void dbAdapter
    .connect()
    .then(async () => {
      console.log('Database connected (read-only mode)');
      const resourceHealth = await getResourceHealth();
      if (!resourceHealth.ok) {
        console.error('Inventory resource probe failed:', resourceHealth.error);
      }
    })
    .catch((error: unknown) => {
      console.error('Database connection unavailable; health will report degraded:', error);
    });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`);
    await app.close();
    await dbAdapter.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      console.error('Shutdown error on SIGINT:', err);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      console.error('Shutdown error on SIGTERM:', err);
      process.exit(1);
    });
  });

  return app;
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(resolve(invokedFile)).href) {
  startConnector().catch((err) => {
    console.error('Failed to start connector:', err);
    process.exit(1);
  });
}
