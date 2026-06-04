import { describe, it, expect } from 'vitest';
import { PathTree } from '../../src/arm-a/path-tree.js';

const FIXTURE: Array<{ slug: string }> = [
  { slug: 'quickstart' },
  // `auth` is a section-index: it exists as its own slug AND is a directory
  // prefix of `auth/oauth` / `auth/api-keys`. fromDocPaths must synthesize
  // it as `auth/index` (file under the `auth/` dir) without crashing.
  { slug: 'auth' },
  { slug: 'auth/oauth' },
  { slug: 'auth/api-keys' },
  { slug: 'api/spans' },
  { slug: 'api/traces' },
];

describe('PathTree', () => {
  const tree = PathTree.fromDocPaths(FIXTURE);

  it('lists the root with directories sorted before / mixed with files', () => {
    expect(tree.ls('/')).toEqual(['api/', 'auth/', 'quickstart.mdx']);
  });

  it('lists a subdirectory', () => {
    expect(tree.ls('/auth')).toEqual(['api-keys.mdx', 'index.mdx', 'oauth.mdx']);
  });

  it('lists a subdirectory with trailing slash (idempotent)', () => {
    expect(tree.ls('/auth/')).toEqual(['api-keys.mdx', 'index.mdx', 'oauth.mdx']);
  });

  it('throws ENOTDIR on a path that is a file', () => {
    expect(() => tree.ls('/auth/oauth.mdx')).toThrow(/ENOTDIR|not a directory/i);
  });

  it('throws ENOENT on a nonexistent path', () => {
    expect(() => tree.ls('/does-not-exist')).toThrow(/ENOENT|no such/i);
  });

  it('resolves an existing file path to its slug', () => {
    expect(tree.resolveFile('/auth/oauth.mdx')).toBe('auth/oauth');
  });

  it('resolves bare slug path (no .mdx) to the same slug', () => {
    expect(tree.resolveFile('/auth/oauth')).toBe('auth/oauth');
  });

  it('returns null on resolveFile for a directory', () => {
    expect(tree.resolveFile('/auth')).toBeNull();
  });

  it('find walks recursively from a directory', () => {
    expect(tree.find('/api').sort()).toEqual(['/api/spans.mdx', '/api/traces.mdx']);
  });

  it('find from / returns every file', () => {
    expect(tree.find('/').sort()).toEqual([
      '/api/spans.mdx',
      '/api/traces.mdx',
      '/auth/api-keys.mdx',
      '/auth/index.mdx',
      '/auth/oauth.mdx',
      '/quickstart.mdx',
    ]);
  });

  it('isDirectory / isFile mirror the structure', () => {
    expect(tree.isDirectory('/auth')).toBe(true);
    expect(tree.isFile('/auth/oauth.mdx')).toBe(true);
    expect(tree.isDirectory('/auth/oauth.mdx')).toBe(false);
  });

  // ─── section-index synthesis (live-corpus shape: bare `ax`, `ax/cookbooks`, …) ──

  it('synthesizes a section-index slug as <slug>/index.mdx inside its own dir', () => {
    expect(tree.isDirectory('/auth')).toBe(true);
    expect(tree.isFile('/auth/index.mdx')).toBe(true);
    expect(tree.ls('/auth')).toContain('index.mdx');
  });

  it('resolveFile on the synthesized index returns the original slug', () => {
    expect(tree.resolveFile('/auth/index.mdx')).toBe('auth');
    expect(tree.resolveFile('/auth/index')).toBe('auth');
  });

  it('deeply-nested section-index slugs are synthesized at every level', () => {
    const deep = PathTree.fromDocPaths([
      { slug: 'ax' },
      { slug: 'ax/cookbooks' },
      { slug: 'ax/cookbooks/agents/foo' },
    ]);
    expect(deep.resolveFile('/ax/index.mdx')).toBe('ax');
    expect(deep.resolveFile('/ax/cookbooks/index.mdx')).toBe('ax/cookbooks');
    expect(deep.resolveFile('/ax/cookbooks/agents/foo.mdx')).toBe('ax/cookbooks/agents/foo');
  });

  // `.mdx`-suffixed paths must resolve only to FileNodes. A lenient fallback
  // (strip `.mdx`, look up the bare segment, return a DirNode for section-index
  // slugs) would let grep walks emit `.mdx`-in-middle paths like
  // `/ax/cookbooks.mdx/agents/foo.mdx` alongside the real path.

  it('rejects .mdx-suffixed paths that target section-index DirNodes', () => {
    // /auth/index.mdx is the canonical section-index file path; /auth.mdx
    // must NOT resolve to the section-index dir (would re-introduce dual-resolve).
    expect(tree.isDirectory('/auth.mdx')).toBe(false);
    expect(tree.isFile('/auth.mdx')).toBe(false);
    expect(() => tree.ls('/auth.mdx')).toThrow(/ENOENT|no such/i);
    expect(() => tree.find('/auth.mdx')).toThrow(/ENOENT|no such/i);
  });

  it('rejects .mdx-suffixed segments mid-path (no walking into a section-index dir via .mdx)', () => {
    const deep = PathTree.fromDocPaths([
      { slug: 'ax' },
      { slug: 'ax/cookbooks' },
      { slug: 'ax/cookbooks/agents/foo' },
    ]);
    // /ax/cookbooks.mdx/agents/foo.mdx is the dual-resolve symptom — must not resolve.
    expect(deep.isFile('/ax/cookbooks.mdx/agents/foo.mdx')).toBe(false);
    expect(deep.isDirectory('/ax/cookbooks.mdx')).toBe(false);
  });

  it('exposes isSectionIndex for grep prefetch path routing', () => {
    expect(tree.isSectionIndex('auth')).toBe(true);
    expect(tree.isSectionIndex('auth/oauth')).toBe(false);
    expect(tree.isSectionIndex('quickstart')).toBe(false);
    expect(tree.isSectionIndex('does-not-exist')).toBe(false);
  });

  it('slugToFsPath routes section-index slugs to /<slug>/index.mdx; others to /<slug>.mdx', () => {
    expect(tree.slugToFsPath('auth')).toBe('/auth/index.mdx');
    expect(tree.slugToFsPath('auth/oauth')).toBe('/auth/oauth.mdx');
    expect(tree.slugToFsPath('quickstart')).toBe('/quickstart.mdx');
  });
});
