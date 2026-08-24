#!/usr/bin/env node

import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';

export function getCliCommand(args: readonly string[]): 'setup' | 'validate' | 'start' {
  if (args[0] === 'setup') return 'setup';
  if (args[0] === 'validate') return 'validate';
  return 'start';
}

export async function validateConnectorConfig(configPath: string): Promise<void> {
  const { loadConfig } = await import('../config/config.loader.js');
  const { createDatabaseAdapter } = await import('../db/adapter.factory.js');
  const { probeInventoryResource } = await import('../routes/health.route.js');
  try {
    await access(configPath);
  } catch {
    throw new Error(`Configuration file "${configPath}" does not exist.`);
  }

  const config = loadConfig(configPath);
  const dbAdapter = createDatabaseAdapter(config.database);
  try {
    await dbAdapter.connect();
    await probeInventoryResource(dbAdapter, config.resources.inventory);
  } finally {
    await dbAdapter.disconnect();
  }
}

async function run(): Promise<void> {
  const command = getCliCommand(process.argv.slice(2));
  if (command === 'setup') {
    const { runWizard } = await import('./wizard.js');
    try {
      await runWizard();
    } catch (error) {
      if (error instanceof Error && error.message.includes('User force closed')) {
        console.log('\nSetup cancelled.');
        process.exit(0);
      }
      console.error('\nSetup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (command === 'validate') {
    try {
      const configPath = process.env['CONFIG_PATH'] ?? resolve('connector.config.yml');
      console.log(`Validating ${configPath}...`);
      await validateConnectorConfig(configPath);
      console.log('Configuration and inventory resource probe passed.');
    } catch (error) {
      console.error('\nValidation failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    // Default: start the server
    const { startConnector } = await import('../index.js');
    await startConnector();
  }
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(resolve(invokedFile)).href) {
  await run();
}
