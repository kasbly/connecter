import 'dotenv/config';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { loadConfig } from './config/config.loader.js';
import { createDatabaseAdapter } from './db/adapter.factory.js';
import { buildApp } from './server.js';

const DEFAULT_CONFIG_PATH = resolve('connector.config.yml');
const CONFIG_PATH = process.env['CONFIG_PATH'] ?? DEFAULT_CONFIG_PATH;

/**
 * Validates that the config file path exists and is accessible.
 *
 * @param path - Path to the connector config file
 * @throws {Error} If the file does not exist
 */
async function validateConfigPath(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `CONFIG_PATH "${path}" does not exist. ` +
        'Set the CONFIG_PATH environment variable to point to a valid connector.config.yml file.',
    );
  }
}

async function main(): Promise<void> {
  console.log(`Loading config from ${CONFIG_PATH}`);
  await validateConfigPath(CONFIG_PATH);
  const config = loadConfig(CONFIG_PATH);

  const dbAdapter = createDatabaseAdapter(config.database);
  console.log(
    `Connecting to ${config.database.type} at ${config.database.host}:${config.database.port}...`,
  );
  await dbAdapter.connect();
  console.log('Database connected (read-only mode)');

  const app = await buildApp({ config, dbAdapter });

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

  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(`Kasbly Connector listening on ${config.server.host}:${config.server.port}`);
}

main().catch((err) => {
  console.error('Failed to start connector:', err);
  process.exit(1);
});
