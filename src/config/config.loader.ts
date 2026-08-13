import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { connectorConfigSchema } from './config.schema.js';
import type { ConnectorConfig } from './config.types.js';

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export function interpolateEnvVars(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('#')) {
        return line;
      }

      return line.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
        const value = process.env[varName];
        if (value === undefined) {
          throw new Error(`Environment variable "${varName}" is not set`);
        }
        return value;
      });
    })
    .join('\n');
}

export function loadConfig(configPath: string): ConnectorConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = interpolateEnvVars(raw);
  // js-yaml v5 throws on empty/whitespace-only input instead of returning
  // undefined; normalise that back to undefined so schema validation produces
  // the meaningful "config is invalid" error rather than a raw parser throw.
  const parsed: unknown = interpolated.trim() === '' ? undefined : yaml.load(interpolated);
  const validated = connectorConfigSchema.parse(parsed);
  return validated as ConnectorConfig;
}
