import { describe, it, expect, vi, beforeEach } from 'vitest';
import { interpolateEnvVars, loadConfig } from '../config.loader.js';

describe('interpolateEnvVars', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces ${VAR} with environment variable values', () => {
    vi.stubEnv('MY_VAR', 'hello');
    expect(interpolateEnvVars('value: ${MY_VAR}')).toBe('value: hello');
  });

  it('replaces multiple variables', () => {
    vi.stubEnv('HOST', 'localhost');
    vi.stubEnv('PORT', '5432');
    expect(interpolateEnvVars('${HOST}:${PORT}')).toBe('localhost:5432');
  });

  it('throws when environment variable is not defined', () => {
    expect(() => interpolateEnvVars('${UNDEFINED_VAR}')).toThrow(
      'Environment variable "UNDEFINED_VAR" is not set',
    );
  });

  it('leaves text without variables unchanged', () => {
    expect(interpolateEnvVars('no variables here')).toBe('no variables here');
  });
});

describe('loadConfig', () => {
  it('throws when file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path.yml')).toThrow();
  });
});
