#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function getCliCommand(args: readonly string[]): 'setup' | 'start' {
  return args[0] === 'setup' ? 'setup' : 'start';
}

async function run(): Promise<void> {
  if (getCliCommand(process.argv.slice(2)) === 'setup') {
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
  } else {
    // Default: start the server
    await import('../index.js');
  }
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(resolve(invokedFile)).href) {
  await run();
}
