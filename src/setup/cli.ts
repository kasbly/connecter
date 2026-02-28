#!/usr/bin/env node

const args = process.argv.slice(2);

if (args[0] === 'setup') {
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
