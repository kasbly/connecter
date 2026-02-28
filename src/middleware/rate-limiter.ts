import type { RateLimitConfig } from '../config/config.types.js';

export interface RateLimitOptions {
  max: number;
  timeWindow: string;
}

export function buildRateLimitOptions(config: RateLimitConfig): RateLimitOptions {
  return {
    max: config.maxRequests,
    timeWindow: `${config.windowSeconds} seconds`,
  };
}
