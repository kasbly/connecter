import type { DatabaseConfig } from '../config/config.types.js';
import type { DatabaseAdapter } from './adapter.interface.js';
import { PostgresAdapter } from './postgres.adapter.js';

export function createDatabaseAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'postgres':
      return new PostgresAdapter(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unsupported database type: ${String(_exhaustive)}`);
    }
  }
}
