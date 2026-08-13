import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter.interface.js';
import { registerHealthRoute } from '../health.route.js';

function createHealthAdapter(healthy: boolean): DatabaseAdapter {
  return {
    healthCheck: vi.fn().mockResolvedValue(healthy),
  } as unknown as DatabaseAdapter;
}

describe('health route', () => {
  it('returns 200 when the database is connected', async () => {
    const app = Fastify();
    registerHealthRoute(app, createHealthAdapter(true));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
    await app.close();
  });

  it('returns 503 when the database is disconnected', async () => {
    const app = Fastify();
    registerHealthRoute(app, createHealthAdapter(false));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: 'disconnected',
    });
    await app.close();
  });
});
