import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from './config/config.loader.js';
import { createDatabaseAdapter } from './db/adapter.factory.js';
import { buildApp } from './server.js';

const CONFIG_PATH = process.env['CONFIG_PATH'] ?? resolve('connector.config.yml');

async function main(): Promise<void> {
  console.log(`Loading config from ${CONFIG_PATH}`);
  const config = loadConfig(CONFIG_PATH);

  const dbAdapter = createDatabaseAdapter(config.database);
  console.log(`Connecting to ${config.database.type} at ${config.database.host}:${config.database.port}...`);
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

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(`Kasbly Connector listening on ${config.server.host}:${config.server.port}`);
}

main().catch((err) => {
  console.error('Failed to start connector:', err);
  process.exit(1);
});
