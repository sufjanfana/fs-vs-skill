import { describe, it, expect } from 'vitest';
import { isTransient } from '../../src/shared/transient.js';

describe('isTransient', () => {
  it('detects rate-limit messages', () => {
    expect(isTransient(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('detects 5xx codes', () => {
    expect(isTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransient(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('detects socket/timeout errors', () => {
    expect(isTransient(new Error('socket hang up'))).toBe(true);
    expect(isTransient(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns false for genuine errors', () => {
    expect(isTransient(new Error('SyntaxError: unexpected token'))).toBe(false);
    expect(isTransient(new Error('TypeError: x is not a function'))).toBe(false);
    expect(isTransient(new Error('input validation failed'))).toBe(false);
  });

  it('handles non-Error inputs', () => {
    expect(isTransient('429 too many requests')).toBe(true);
    expect(isTransient('hello world')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});
