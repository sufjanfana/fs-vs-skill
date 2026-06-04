import { describe, it, expect } from 'vitest';
import { QUESTIONS, PROBE_QUESTION } from '../../src/eval/questions.js';

describe('questions.ts structural invariants', () => {
  it('has exactly 10 questions', () => {
    expect(QUESTIONS.length).toBe(10);
  });

  it('each question has all required fields', () => {
    for (const q of QUESTIONS) {
      expect(typeof q.id).toBe('string');
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.prompt).toBe('string');
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(['quant', 'content', 'structural']).toContain(q.shape);
      expect(typeof q.p_grader).toBe('function');
      expect(typeof q.l_grader_rubric).toBe('object');
      expect(Array.isArray(q.l_grader_rubric.required)).toBe(true);
      expect(Array.isArray(q.l_grader_rubric.disqualifying)).toBe(true);
    }
  });

  it('IDs are unique and cover the 10 (q1–q10)', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(10);
    for (const id of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10']) {
      expect(ids).toContain(id);
    }
  });

  it('L-graded questions (q1, q7, q10) carry non-empty rubric required items', () => {
    // The set has 3 L-graded questions; the P-graded questions intentionally
    // have empty rubrics — they are not L-graded.
    const lGradedIds = new Set(['q1', 'q7', 'q10']);
    const lQs = QUESTIONS.filter((q) => lGradedIds.has(q.id));
    expect(lQs.length).toBe(3);
    for (const q of lQs) {
      expect(q.l_grader_rubric.required.length).toBeGreaterThan(0);
    }
  });

  it('complexity_tier distribution is 3 simple / 4 mid / 3 complex', () => {
    const tiers = QUESTIONS.reduce<Record<string, number>>((acc, q) => {
      acc[q.complexity_tier] = (acc[q.complexity_tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(tiers).toEqual({ simple: 3, mid: 4, complex: 3 });
  });

  it('q3 is the falsifiability canary — tagged simple, P-graded with distinctSet', () => {
    const q3 = QUESTIONS.find((q) => q.id === 'q3');
    expect(q3).toMatchObject({ id: 'q3', complexity_tier: 'simple' });
    expect(typeof q3!.p_grader).toBe('function');
    // q3 grader rejects extras and dups (pre-registered canary):
    // a passing answer must be exactly the 7 installation suffixes.
    const tooMany = 'configuring-ingress-endpoints\nconfiguring-saml\ninstallation-on-aws\ninstallation-on-azure\ninstallation-on-gcp\ninstallation-on-openshift\ninstallation-on-single-host\nbogus-extra';
    expect(q3!.p_grader(tooMany).passed).toBe(false);
    const exact = 'configuring-ingress-endpoints\nconfiguring-saml\ninstallation-on-aws\ninstallation-on-azure\ninstallation-on-gcp\ninstallation-on-openshift\ninstallation-on-single-host';
    expect(q3!.p_grader(exact).passed).toBe(true);
  });

  it('probe question has a distinct ID and is not in the 10', () => {
    expect(PROBE_QUESTION.id).toBe('PROBE');
    for (const q of QUESTIONS) {
      expect(q.id).not.toBe(PROBE_QUESTION.id);
      expect(q.prompt).not.toBe(PROBE_QUESTION.prompt);
    }
  });
});
