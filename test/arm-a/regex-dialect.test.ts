import { describe, it, expect } from 'vitest';
import { toPgIlike, toPgRegex, ilikeFilter, regexFilter } from '../../src/arm-a/regex-dialect.js';

describe('toPgIlike', () => {
  it('wraps with %...% and escapes Postgres LIKE wildcards', () => {
    expect(toPgIlike('OAuth')).toBe('%OAuth%');
    expect(toPgIlike('50%')).toBe('%50\\%%');
    expect(toPgIlike('a_b')).toBe('%a\\_b%');
  });

  it('escapes backslash literals', () => { expect(toPgIlike('a\\b')).toBe('%a\\\\b%'); });
});

describe('toPgRegex', () => {
  it('passes simple character classes through', () => {
    expect(toPgRegex('[Oo]Auth')).toBe('[Oo]Auth');
  });

  it('preserves anchors', () => {
    expect(toPgRegex('^Welcome')).toBe('^Welcome');
  });
});

describe('ilikeFilter', () => {
  it('wraps the substring in a %...% ILIKE param', () => {
    expect(ilikeFilter('OAuth')).toEqual({ sql: 'content ILIKE $1', param: '%OAuth%' });
  });
});

describe('regexFilter', () => {
  it('prefixes (?n) so ^/$ anchor per line like grep, not the whole content', () => {
    expect(regexFilter('^Welcome')).toEqual({ sql: 'content ~* $1', param: '(?n)^Welcome' });
  });
});
