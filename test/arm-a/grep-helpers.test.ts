import { describe, it, expect } from 'vitest';
import { slugScopeFromPath } from '../../src/arm-a/grep.js';
import { parseGrepPatternAndPath } from '../../src/arm-a/mcp-server.js';

describe('slugScopeFromPath', () => {
  it('returns null for the root', () => {
    expect(slugScopeFromPath('/')).toBeNull();
    expect(slugScopeFromPath('')).toBeNull();
  });

  it('strips the leading slash for a directory target', () => {
    expect(slugScopeFromPath('/ax/cookbooks')).toBe('ax/cookbooks');
  });

  it('strips a .mdx suffix so a file target matches its bare slug', () => {
    expect(slugScopeFromPath('/ax/integrations/openai.mdx')).toBe('ax/integrations/openai');
  });

  it('strips a trailing slash', () => {
    expect(slugScopeFromPath('/ax/cookbooks/')).toBe('ax/cookbooks');
  });
});

describe('parseGrepPatternAndPath', () => {
  const cwd = '/docs';

  it('reads the first positional as pattern and the second as the path target', () => {
    expect(parseGrepPatternAndPath(['grep', 'auth', '/ax'], cwd)).toEqual({ pattern: 'auth', target: '/ax' });
  });

  it('defaults the target to cwd when no path is given', () => {
    expect(parseGrepPatternAndPath(['grep', '-i', 'auth'], cwd)).toEqual({ pattern: 'auth', target: cwd });
  });

  it('treats the value after -e as the pattern, not a consumed flag value', () => {
    expect(parseGrepPatternAndPath(['grep', '-e', 'auth', '/ax'], cwd)).toEqual({ pattern: 'auth', target: '/ax' });
  });

  it('still consumes the numeric value of -m before the pattern', () => {
    expect(parseGrepPatternAndPath(['grep', '-m', '5', 'auth', '/ax'], cwd)).toEqual({ pattern: 'auth', target: '/ax' });
  });

  it('treats everything after -- as positional', () => {
    expect(parseGrepPatternAndPath(['grep', '--', '-dashish', '/ax'], cwd)).toEqual({ pattern: '-dashish', target: '/ax' });
  });
});
