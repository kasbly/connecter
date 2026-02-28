import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { connectorConfigSchema } from './config.schema.js';
import type { ConnectorConfig } from './config.types.js';

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export function interpolateEnvVars(content: string): string {
  return content.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable "${varName}" is not set`);
    }
    return value;
  });
}

export function loadConfig(configPath: string): ConnectorConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = interpolateEnvVars(raw);
  const parsed: unknown = yaml.load(interpolated);
  const validated = connectorConfigSchema.parse(parsed);
  return validated as ConnectorConfig;
}
