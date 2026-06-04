// L-judge: rubric checklist → per-item CoT → binary verdict. Cite-set existence
// is programmatic and runs BEFORE this judge (see verify-cites).

import Anthropic from '@anthropic-ai/sdk';
import { JUDGE_MODEL, API_TIMEOUT_MS } from '../shared/config.js';
import type { LGraderRubric } from './questions.js';

export { isTransient } from '../shared/transient.js';

export interface ItemEvaluation {
  item: string;
  verdict: 'pass' | 'fail';
  reason: string;
}

// Field order mirrors the prompt template (reasoning → reason → verdict)
// so the binary `pass` commits after all the chain-of-thought.
export interface JudgeResult {
  item_evaluations: ItemEvaluation[];
  reason: string;
  pass: boolean;
}

export async function judgeOne(
  rubric: LGraderRubric,
  question: string,
  answer: string,
): Promise<JudgeResult> {
  const requiredList = rubric.required.map((s, i) => `R${i + 1}. ${s}`).join('\n');
  const disqualifyingList = rubric.disqualifying.map((s, i) => `D${i + 1}. ${s}`).join('\n');

  const sections: string[] = [];
  sections.push(`You are a strict grader. Question: ${question}`);
  sections.push(`Answer to grade:\n${answer}`);
  if (requiredList) sections.push(`Required items (ALL must be met):\n${requiredList}`);
  if (disqualifyingList) sections.push(`Disqualifying items (NONE may be tripped):\n${disqualifyingList}`);
  sections.push(
    'For EACH item above, evaluate whether the answer satisfies the rule. ' +
      'Provide a one-line reason per item. The answer PASSES iff all required items ' +
      'are met AND no disqualifying items are tripped.',
  );
  sections.push(
    'Reply with a single-line JSON object (no markdown fences, no leading prose). ' +
      'Emit fields in this exact order — reasoning first, verdict last:\n' +
      '{"item_evaluations":[{"item":"R1","verdict":"pass"|"fail","reason":"<one-line>"},...],' +
      '"reason":"<one-line overall verdict>","pass":true|false}',
  );
  const prompt = sections.join('\n\n');

  // Sampling intentionally unpinned (see judge-consistency); client per-call
  // to avoid pooled state leak across cells.
  // max_tokens budget: binary verdict + per-item CoT for the largest rubric
  // (q10 has 5 required + 2 disqualifying items).
  const client = new Anthropic();
  const m = await client.messages.create(
    {
      model: JUDGE_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: API_TIMEOUT_MS },
  );
  const text = m.content.find((c) => c.type === 'text')?.text ?? '';

  try {
    const obj = JSON.parse(text.trim()) as unknown;
    if (typeof obj !== 'object' || obj === null) {
      return {
        pass: false,
        reason: `judge returned non-object JSON: ${text.slice(0, 200)}`,
        item_evaluations: [],
      };
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.pass !== 'boolean') {
      return {
        pass: false,
        reason: `judge returned non-boolean pass: ${text.slice(0, 200)}`,
        item_evaluations: [],
      };
    }
    const itemsRaw = Array.isArray(rec.item_evaluations) ? rec.item_evaluations : [];
    const items: ItemEvaluation[] = itemsRaw.map((e) => {
      const er = (typeof e === 'object' && e !== null) ? (e as Record<string, unknown>) : {};
      return {
        item: String(er.item ?? ''),
        verdict: er.verdict === 'pass' ? 'pass' : 'fail',
        reason: String(er.reason ?? ''),
      };
    });
    return {
      item_evaluations: items,
      reason: String(rec.reason ?? ''),
      pass: rec.pass,
    };
  } catch {
    return {
      item_evaluations: [],
      reason: `judge returned malformed JSON: ${text.slice(0, 200)}`,
      pass: false,
    };
  }
}
