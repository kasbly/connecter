import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCliCommand } from '../cli.js';

const packageJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));

describe('connector setup CLI', () => {
  it('dispatches the setup subcommand to the wizard', () => {
    expect(getCliCommand(['setup'])).toBe('setup');
  });

  it('keeps a bare CLI invocation on the server path', () => {
    expect(getCliCommand([])).toBe('start');
  });

  it('dispatches the validate subcommand without starting the server', () => {
    expect(getCliCommand(['validate'])).toBe('validate');
  });

  it('passes the setup subcommand from the documented npm script', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['setup']).toBe('tsx src/setup/cli.ts setup');
    expect(packageJson.scripts['validate']).toBe('tsx src/setup/cli.ts validate');
  });
});
