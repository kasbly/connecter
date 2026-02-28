import { describe, it, expect } from 'vitest';
import { findMatchingKey } from '../api-key.guard.js';

describe('findMatchingKey', () => {
  const keys = [
    { key: 'test-key-1', label: 'production' },
    { key: 'test-key-2', label: 'staging' },
  ];

  it('returns matching key config for valid key', () => {
    const result = findMatchingKey('test-key-1', keys);
    expect(result).toEqual({ key: 'test-key-1', label: 'production' });
  });

  it('returns second key when matching', () => {
    const result = findMatchingKey('test-key-2', keys);
    expect(result).toEqual({ key: 'test-key-2', label: 'staging' });
  });

  it('returns undefined for invalid key', () => {
    const result = findMatchingKey('wrong-key', keys);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const result = findMatchingKey('', keys);
    expect(result).toBeUndefined();
  });

  it('does not match partial keys', () => {
    const result = findMatchingKey('test-key', keys);
    expect(result).toBeUndefined();
  });
});
