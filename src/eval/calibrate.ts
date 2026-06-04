import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { runCell } from '../shared/run-cell.js';
import { ARM_B_SKILL_BUNDLE_REL } from '../arm-b/workdir.js';
import { QUESTIONS } from './questions.js';
import { SmokeGateFailure } from './smoke.js';

export interface CalibrationPerQuestion {
  question: string;
  skill_fired: boolean;
  tool_call_count: number;
  terminate_reason: string;
  trajectory: string[];
}

export interface CalibrationReport {
  trigger_rate: number;
  failures: Array<{ question: string; reason: string }>;
  fixture_sha256: string;
  per_question: CalibrationPerQuestion[];
}

export async function runCalibration(args: {
  emptyConfigDir: string;
  pool: Pool;
  repoRoot: string;
  logsDir: string;
}): Promise<CalibrationReport> {
  const failures: CalibrationReport['failures'] = [];
  const per_question: CalibrationPerQuestion[] = [];

  for (const q of QUESTIONS) {
    const out = await runCell({
      arm: 'b', question: q.prompt,
      emptyConfigDir: args.emptyConfigDir,
      pool: args.pool,
      repoRoot: args.repoRoot,
    });
    const trajectory = out.turns.flatMap((t) => t.tool_calls.map((c) => c.name));
    const skill_fired = trajectory.includes('Skill');
    per_question.push({
      question: q.prompt,
      skill_fired,
      tool_call_count: out.run.tool_call_count,
      terminate_reason: out.run.terminate_reason,
      trajectory,
    });
    if (!skill_fired) failures.push({ question: q.prompt, reason: 'Skill tool did not fire' });
  }

  const trigger_rate = (QUESTIONS.length - failures.length) / QUESTIONS.length;
  const fixture_sha256 = await captureFixtureSha256(args.repoRoot);

  const report: CalibrationReport = { trigger_rate, failures, fixture_sha256, per_question };

  await mkdir(args.logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const reportPath = path.join(args.logsDir, `calibration_${ts}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  if (trigger_rate < 1.0) {
    throw new SmokeGateFailure(
      'phase-2-calibration',
      `Skill trigger rate ${(trigger_rate * 100).toFixed(0)}%, expected 100%. ` +
      `Failures: ${failures.map((f) => f.question).join('; ')}. ` +
      `See ${reportPath} for full per-question detail.`,
    );
  }

  return report;
}

async function captureFixtureSha256(repoRoot: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  // Exclude .sql_metrics.jsonl so test/run cwd inside the bundle can't mutate
  // the hash mid-batch (the ./sql script also refuses to run in that case).
  const findCmd = `find ${ARM_B_SKILL_BUNDLE_REL} -type f ! -name '.sql_metrics.jsonl'`;
  const { stdout: listing } = await exec('bash', ['-c', findCmd], { cwd: repoRoot });
  if (listing.trim() === '') {
    throw new Error(
      `captureFixtureSha256: no files found under ${ARM_B_SKILL_BUNDLE_REL} (repoRoot=${repoRoot}). ` +
      `Bundle path is wrong or the bundle has been moved.`,
    );
  }
  const { stdout } = await exec(
    'bash',
    ['-c', `${findCmd} -exec sha256sum {} \\; | sort | sha256sum | awk '{print $1}'`],
    { cwd: repoRoot },
  );
  return stdout.trim();
}
