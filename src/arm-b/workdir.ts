import { mkdir, cp, rm, readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Single source of truth for the Arm-B skill bundle path (relative to repo root).
// Consumers: setupArmB in run-cell.ts; the fixture-sha capture in calibrate.ts.
export const ARM_B_SKILL_BUNDLE_REL = 'src/arm-b/skill/.claude';

export interface CreateWorkdirOpts {
  prefix: string;     // e.g. /tmp/armb_run_
  uuid: string;       // randomUUID()
  fixture: string;    // absolute path to src/arm-b/skill/.claude
}

// `.claude` is COPIED (not symlinked) so any spill / sidecar / agent-issued
// write inside the bundle lands in this throwaway workdir, never in the
// source tree (a symlink would let agent writes through `cd` into the
// bundle pollute `src/` and shift the next batch's fixture hash).
export async function createWorkdir(opts: CreateWorkdirOpts): Promise<string> {
  const dir = `${opts.prefix}${opts.uuid}`;
  await mkdir(dir, { recursive: true });
  await cp(opts.fixture, path.join(dir, '.claude'), { recursive: true });
  return dir;
}

export async function removeWorkdir(workdir: string): Promise<void> {
  await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function findWorkdirs(prefix: string): Promise<string[]> {
  const parent = path.dirname(prefix);
  const base = path.basename(prefix);
  if (!existsSync(parent)) return [];
  const entries = await readdir(parent);
  const out: string[] = [];
  for (const e of entries) {
    if (!e.startsWith(base)) continue;
    const full = path.join(parent, e);
    try {
      const s = await lstat(full);
      if (s.isDirectory() && !s.isSymbolicLink()) out.push(full);
    } catch { /* race; ignore */ }
  }
  return out;
}

export async function sweepStaleWorkdirs(prefix: string): Promise<void> {
  for (const w of await findWorkdirs(prefix)) {
    await removeWorkdir(w);
  }
}
