import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat, writeFile as writeFileFs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkdir, removeWorkdir, sweepStaleWorkdirs, findWorkdirs } from '../../src/arm-b/workdir.js';

describe('workdir helpers', () => {
  let fixture: string;
  let prefix: string;

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'workdir-fixture-'));
    await mkdir(path.join(fixture, 'skills/sql-skill'), { recursive: true });
    await writeFile(path.join(fixture, 'skills/sql-skill/SKILL.md'), '# SKILL\n');
    await writeFile(path.join(fixture, 'settings.json'), '{}');
    prefix = path.join(tmpdir(), 'armb_run_test_');
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
    await sweepStaleWorkdirs(prefix);
  });

  it('createWorkdir copies .claude into the workdir (not a symlink)', async () => {
    const w = await createWorkdir({ prefix, uuid: 'aaa', fixture });
    expect(existsSync(w)).toBe(true);
    expect(existsSync(path.join(w, '.claude'))).toBe(true);
    const s = await lstat(path.join(w, '.claude'));
    expect(s.isSymbolicLink()).toBe(false);
    expect(s.isDirectory()).toBe(true);
    const skill = await readFile(path.join(w, '.claude/skills/sql-skill/SKILL.md'), 'utf8');
    expect(skill).toBe('# SKILL\n');
  });

  it('writes inside the workdir bundle do not reach the source fixture', async () => {
    // Defense-in-depth: previously the .claude symlink let an agent's write
    // through `result_1.ndjson` reach the source bundle. With the copy, the
    // source must stay untouched.
    const w = await createWorkdir({ prefix, uuid: 'isolate', fixture });
    const polluteHere = path.join(w, '.claude/skills/sql-skill/result_test.ndjson');
    await writeFileFs(polluteHere, 'workdir-only\n');
    expect(existsSync(polluteHere)).toBe(true);
    expect(existsSync(path.join(fixture, 'skills/sql-skill/result_test.ndjson'))).toBe(false);
  });

  it('removeWorkdir wipes the copy without touching the source fixture', async () => {
    const w = await createWorkdir({ prefix, uuid: 'bbb', fixture });
    await removeWorkdir(w);
    expect(existsSync(w)).toBe(false);
    expect(existsSync(fixture)).toBe(true);  // fixture survives
    const skill = await readFile(path.join(fixture, 'skills/sql-skill/SKILL.md'), 'utf8');
    expect(skill).toBe('# SKILL\n');
  });

  it('findWorkdirs returns all matching workdirs', async () => {
    await createWorkdir({ prefix, uuid: 'ccc', fixture });
    await createWorkdir({ prefix, uuid: 'ddd', fixture });
    const found = await findWorkdirs(prefix);
    expect(found.length).toBe(2);
    expect(found.every((p) => p.startsWith(prefix))).toBe(true);
  });

  it('sweepStaleWorkdirs removes all matching dirs', async () => {
    await createWorkdir({ prefix, uuid: 'eee', fixture });
    await createWorkdir({ prefix, uuid: 'fff', fixture });
    await sweepStaleWorkdirs(prefix);
    expect(await findWorkdirs(prefix)).toEqual([]);
  });
});
