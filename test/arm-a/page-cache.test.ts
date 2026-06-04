import { describe, it, expect } from 'vitest';
import { PageCache } from '../../src/arm-a/page-cache.js';

describe('PageCache', () => {
  it('returns undefined on miss and increments cache_misses', () => {
    const c = new PageCache(10);
    expect(c.get('quickstart')).toBeUndefined();
    expect(c.stats()).toEqual({ hits: 0, misses: 1, size: 0 });
  });

  it('returns set value on hit and increments cache_hits', () => {
    const c = new PageCache(10);
    c.set('quickstart', 'hello world');
    expect(c.get('quickstart')).toBe('hello world');
    expect(c.stats()).toEqual({ hits: 1, misses: 0, size: 1 });
  });

  it('evicts the least-recently-used entry past max', () => {
    const c = new PageCache(2);
    c.set('a', '1'); c.set('b', '2'); c.set('c', '3');
    expect(c.get('a')).toBeUndefined();   // evicted
    expect(c.get('b')).toBe('2');
    expect(c.get('c')).toBe('3');
  });

  it('respects bulkSet for prefetch (one call, many entries)', () => {
    const c = new PageCache(10);
    c.bulkSet([['a', '1'], ['b', '2'], ['c', '3']]);
    expect(c.size()).toBe(3);
    expect(c.get('a')).toBe('1');
  });

  it('clear empties and resets size (but not lifetime stats)', () => {
    const c = new PageCache(10);
    c.set('a', '1'); c.get('a'); c.get('b');
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.stats()).toEqual({ hits: 1, misses: 1, size: 0 });
  });
});
