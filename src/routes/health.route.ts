import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { DatabaseAdapter } from '../db/adapter.interface.js';

let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    cachedVersion = pkg.version;
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

const startTime = Date.now();

export function registerHealthRoute(
  app: FastifyInstance,
  dbAdapter: DatabaseAdapter,
): void {
  app.get('/health', async (_request, _reply) => {
    const dbHealthy = await dbAdapter.healthCheck();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    return {
      status: dbHealthy ? 'ok' : 'degraded',
      version: getVersion(),
      database: dbHealthy ? 'connected' : 'disconnected',
      uptime: uptimeSeconds,
    };
  });
}
