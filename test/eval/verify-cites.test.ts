import { describe, it, expect } from 'vitest';
import { extractCitedSlugs } from '../../src/eval/verify-cites.js';

describe('extractCitedSlugs', () => {
  it('parses canonical `Cited pages:` block', () => {
    const answer = 'Some prose.\n\nCited pages:\napi/spans\nauth/oauth';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });

  it('strips leading `/` and `.mdx` / `.md` suffix', () => {
    const answer = 'Cited pages:\n/api/spans.mdx\n/auth/oauth.md';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });

  it('handles bullet-list cite block', () => {
    const answer = 'Cited pages:\n- api/spans\n- auth/oauth';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });

  it('case-insensitive header (`CITED PAGES:`)', () => {
    const answer = 'Some prose.\n\nCITED PAGES:\napi/spans';
    expect(extractCitedSlugs(answer)).toEqual(['api/spans']);
  });

  it('returns [] when no `Cited pages:` block is present (prose mentions are the L-judge\'s job)', () => {
    const answer = 'See api/spans for details and check auth/oauth too.';
    expect(extractCitedSlugs(answer)).toEqual([]);
  });

  it('returns [] when answer has no slug-shaped content', () => {
    expect(extractCitedSlugs('Just some prose with no paths.')).toEqual([]);
  });

  it('block-mode rejects non-slug lines (prose noise)', () => {
    const answer = 'Cited pages:\napi/spans is the relevant page\nauth/oauth';
    // First line is not a clean slug — block parser drops it. Second line passes.
    expect(extractCitedSlugs(answer)).toEqual(['auth/oauth']);
  });

  it('block ends at a blank line', () => {
    const answer = 'Cited pages:\napi/spans\nauth/oauth\n\nSome trailing prose.';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });

  it('deduplicates repeated slugs', () => {
    const answer = 'Cited pages:\napi/spans\napi/spans\nauth/oauth';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });

  it('strips trailing `/index` after `.mdx` (synthesized section-landing path)', () => {
    // Arm A surfaces section landings as `/ax/release-notes/index.mdx` even
    // though the canonical slug is `ax/release-notes`. The extractor must
    // normalize the agent's cite back to the canonical slug.
    const answer = 'Cited pages:\nax/release-notes/index.mdx\n/ax/cookbooks/index';
    expect(extractCitedSlugs(answer).sort()).toEqual(['ax/cookbooks', 'ax/release-notes']);
  });

  it('strips surrounding quotes/parens around block-mode slugs (jq-quoted output)', () => {
    const answer = 'Cited pages:\n"api/spans"\n(auth/oauth)';
    expect(extractCitedSlugs(answer).sort()).toEqual(['api/spans', 'auth/oauth']);
  });
});

