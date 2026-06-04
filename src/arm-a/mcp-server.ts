// Substrate-shaped tool surface: ls, cd, cat, grep, find, plus stdin pipe
// filters (sort, uniq, wc, awk, sed, comm, cut, tr, head, tail). `cd`
// is handler-intercepted (closure-scoped cwd). `grep` runs a coarse-filter
// prefetch then delegates a narrowed argv to just-bash. `ls` injects `-F` and
// post-strips non-`/` markers. The `commands` allowlist must stay set —
// omitting it registers ~80 default built-ins (including jq, sqlite3, etc.)
// that would compose Arm B's surface into Arm A.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Pool } from 'pg';
import { Bash } from 'just-bash';
import type { IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions } from 'just-bash';
import { PathTree } from './path-tree.js';
import { PageCache } from './page-cache.js';
import { PostgresFS } from './postgres-fs.js';
import { prefetchGrepCandidates, type PrefetchResult } from './grep.js';
import { PAGE_CACHE_MAX } from '../shared/config.js';

// grep options whose value lives in the next argv token (short forms only;
// long forms like --include=foo carry the value inline).
const GREP_OPTS_TAKING_VALUE = new Set(['-A', '-B', '-C', '-m', '--max-count']);

export interface BuildArmAOpts {
  pool: Pool;
}

export interface BuiltArmA {
  server: ReturnType<typeof createSdkMcpServer>;
  toolNames: string[];
  // Test-only: exercise the handler directly.
  _invoke(input: { cmd: string }): Promise<{
    stdout: string; stderr: string; exitCode: number;
    structuredContent: { db_ms: number; cache_hits: number; cache_misses: number };
  }>;
  dispose(): Promise<void>;
}

class PostgresFsAdapter implements IFileSystem {
  // Accumulated db_ms for the current exec() call; reset by buildArmAMcpServer.handle().
  accDbMs = 0;

  constructor(
    private readonly pgfs: PostgresFS,
    private readonly tree: PathTree,
  ) {}

  async readFile(path: string): Promise<string> {
    const result = await this.pgfs.cat(path);
    this.accDbMs += result.db_ms;
    return result.content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    // just-bash's `cat` reaches the IFileSystem through readFileBuffer; round-trip
    // through readFile so PostgresFS.cat still drives accDbMs / pageCache.
    const content = await this.readFile(path);
    return Buffer.from(content, 'utf8');
  }

  // EROFS contract for the substrate — second floor under the docs_ro role.
  async writeFile(path: string, _content: unknown): Promise<void> {
    throw new Error(`EROFS: read-only filesystem: ${path}`);
  }

  async appendFile(path: string, _content: unknown): Promise<void> {
    throw new Error(`EROFS: read-only filesystem: ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.tree.isDirectory(path) || this.tree.isFile(path);
  }

  async stat(path: string): Promise<FsStat> {
    const isDir = this.tree.isDirectory(path);
    const isFile = this.tree.isFile(path);
    if (!isDir && !isFile) throw new Error(`ENOENT: ${path}`);
    return {
      isFile,
      isDirectory: isDir,
      isSymbolicLink: false,
      mode: isDir ? 0o755 : 0o444,
      size: 0,
      mtime: new Date(0),
    };
  }

  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async readdir(path: string): Promise<string[]> {
    return this.tree.ls(path).map((e) => (e.endsWith('/') ? e.slice(0, -1) : e));
  }

  async rm(_path: string, _options?: RmOptions): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async mv(_src: string, _dest: string): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return path;
    const parts = (base.endsWith('/') ? base : base + '/') + path;
    const segs = parts.split('/');
    const out: string[] = [];
    for (const s of segs) {
      if (s === '' || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return '/' + out.join('/');
  }

  getAllPaths(): string[] {
    return this.tree.find('/');
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async readlink(_path: string): Promise<string> {
    throw new Error('EINVAL: not a symbolic link');
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async realpath(path: string): Promise<string> {
    return path;
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new Error('EROFS: read-only filesystem');
  }
}

export async function buildArmAMcpServer(opts: BuildArmAOpts): Promise<BuiltArmA> {
  const { pool } = opts;
  const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM doc_paths ORDER BY slug');
  const tree = PathTree.fromDocPaths(rows);
  // Size to corpus + headroom so broad-prefetch CTEs (e.g. `grep -rl 'the' /`)
  // don't evict pages before just-bash walks the narrowed candidates.
  const pageCache = new PageCache(Math.max(PAGE_CACHE_MAX, rows.length + 64));
  const pgfs = new PostgresFS(tree, pageCache, pool);
  const fs = new PostgresFsAdapter(pgfs, tree);

  // Closure-scoped cwd: just-bash's ExecOptions.cwd is restored after exec(), so
  // cd state does NOT persist across separate exec() calls. We own cwd tracking.
  let closureCwd = '/';
  let previousCwd = '/';   // for `cd -` support

  // Parallel tool-use serialised so resetStats() / accDbMs don't interleave
  // across concurrent handle() invocations.
  let handleChain: Promise<unknown> = Promise.resolve();

  // defenseInDepth=false: DiD patches globals and breaks custom IFileSystem
  // (just-bash quirk); safe — adapter is RO and we don't run untrusted scripts.
  const justBash = new Bash({
    fs,
    commands: [
      'ls', 'cat', 'grep', 'find',                         // cd is handler-intercepted
      'sort', 'uniq', 'wc', 'awk', 'sed', 'comm',          // composability filters
      'cut', 'tr', 'head', 'tail',                         // glue
      'xargs',                                             // wire a filename list into a second verb (two-stream intersect)
      'echo',                                              // pipeline source for diagnostics
    ],
    defenseInDepth: false,
  });

  async function handle(cmd: string): Promise<{
    stdout: string; stderr: string; exitCode: number;
    structuredContent: { db_ms: number; cache_hits: number; cache_misses: number };
  }> {
    const prev = handleChain;
    const next = (async () => {
      await prev;
      return handleImpl(cmd);
    })();
    // Don't let one call's rejection block the next call.
    handleChain = next.catch(() => undefined);
    return next;
  }

  async function handleImpl(cmd: string) {
    pageCache.resetStats();
    fs.accDbMs = 0;
    let res: { stdout: string; stderr: string; exitCode: number };

    // Intercept `cd ...` before delegating to just-bash.
    const trimmed = cmd.trimStart();
    const isCd = trimmed === 'cd' || trimmed.startsWith('cd ') || trimmed.startsWith('cd\t');
    if (isCd) {
      const args = shellSplit(trimmed.slice(2).trim());
      // Reject `cd X && Y` etc. so the trailing command isn't silently dropped.
      const compoundIdx = args.findIndex((a) => a === '&&' || a === '||' || a === ';' || a === '|');
      if (compoundIdx >= 0) {
        res = {
          stdout: '',
          stderr: `bash: cd: compound commands not supported (saw '${args[compoundIdx]}'); issue cd and the next command as separate calls\n`,
          exitCode: 1,
        };
        const { hits, misses } = pageCache.stats();
        return {
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          structuredContent: { db_ms: fs.accDbMs, cache_hits: hits, cache_misses: misses },
        };
      }
      let target: string;
      let displayTarget: string;
      // HOME is unset in the fake FS; `cd` with no arg or with `~` both
      // resolve to /.
      if (args.length === 0 || args[0] === '~') {
        target = '/';
        displayTarget = args[0] ?? '/';
      } else if (args[0] === '-') {
        target = previousCwd;
        displayTarget = '-';
      } else {
        target = args[0]!;
        displayTarget = target;
      }
      const resolved = fs.resolvePath(closureCwd, target);
      if (tree.isDirectory(resolved)) {
        previousCwd = closureCwd;
        closureCwd = resolved;
        res = { stdout: '', stderr: '', exitCode: 0 };
      } else if (tree.isFile(resolved)) {
        res = { stdout: '', stderr: `bash: cd: ${displayTarget}: Not a directory\n`, exitCode: 1 };
      } else {
        res = { stdout: '', stderr: `bash: cd: ${displayTarget}: No such file or directory\n`, exitCode: 1 };
      }
    } else {
      try {
        const rewritten = await rewriteForJustBash(cmd, { fs, pool, pageCache, tree, closureCwd });
        res = await justBash.exec(rewritten.cmd, { cwd: closureCwd });
        if (rewritten.postProcessStdout) {
          res = { ...res, stdout: rewritten.postProcessStdout(res.stdout) };
        }
        if (rewritten.prependStderr) {
          res = { ...res, stderr: rewritten.prependStderr + res.stderr };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res = { stdout: '', stderr: msg, exitCode: 1 };
      }
    }
    const { hits, misses } = pageCache.stats();
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      structuredContent: { db_ms: fs.accDbMs, cache_hits: hits, cache_misses: misses },
    };
  }

  const server = createSdkMcpServer({
    name: 'postgresfs',
    version: '1.0.0',
    tools: [
      tool(
        'bash',
        'Bash shell. Returns {stdout, stderr, exitCode}.',
        { cmd: z.string() },
        async ({ cmd }) => {
          const r = await handle(cmd);
          const visible = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '');
          return {
            content: [{ type: 'text', text: visible }],
            structuredContent: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, ...r.structuredContent },
          };
        },
      ),
    ],
  });

  return {
    server,
    toolNames: ['bash'],
    _invoke: ({ cmd }) => handle(cmd),
    async dispose() {
      pageCache.clear();
      const remaining = pageCache.size();
      if (remaining !== 0) {
        throw new Error(`cleanup-invariant: Arm A pageCache not cleared (size=${remaining})`);
      }
    },
  };
}

// Rewrite a single-verb command for just-bash.
type RewriteResult = {
  cmd: string;
  postProcessStdout?: (s: string) => string;
  prependStderr?: string;
};

async function rewriteForJustBash(
  cmd: string,
  ctx: {
    fs: PostgresFsAdapter;
    pool: Pool;
    pageCache: PageCache;
    tree: PathTree;
    closureCwd: string;
  },
): Promise<RewriteResult> {
  const argv = shellSplit(cmd);
  if (argv.length === 0) return { cmd };
  const verb = argv[0]!;

  // ls/grep rewrites operate on the leading command segment only. Slice at the
  // first shell operator (`|`, `&&`, `||`, `;`) so the tail — downstream
  // filters, alternates, sequences — passes through untouched.
  const segIdx = argv.findIndex((a) => SHELL_OPERATORS.has(a));
  const headArgv = segIdx === -1 ? argv : argv.slice(0, segIdx);
  const tailArgv = segIdx === -1 ? [] : argv.slice(segIdx);

  if (verb === 'ls') {
    // Inject `-F` so directories print with `/`. Strip the other markers ls -F adds.
    return {
      cmd: reassemble([...injectFFlag(headArgv), ...tailArgv]),
      postProcessStdout: stripNonSlashMarkers,
    };
  }

  if (verb === 'grep') {
    const { pattern, target: rawTarget } = parseGrepPatternAndPath(headArgv, ctx.closureCwd);
    if (pattern === '') return { cmd };
    // Resolve relative paths against closureCwd so the SQL slug scope matches
    // what just-bash will walk.
    const target = ctx.fs.resolvePath(ctx.closureCwd, rawTarget);

    // BRE `\|` is alternation in GNU grep / just-bash, but a literal pair for
    // PostgreSQL's trigram ILIKE. If we leave it as a literal token the coarse
    // filter returns zero candidates and the unnarrowed fall-through walks the
    // entire virtual FS through the adapter. Convert to `|` and force the
    // regex path so the prefetch matches what just-bash will run.
    const hasBreAlt = /\\\|/.test(pattern);
    const effectivePattern = hasBreAlt ? pattern.replace(/\\\|/g, '|') : pattern;
    const isRegex = hasBreAlt || argvHasERegexFlag(headArgv);

    let prefetched: PrefetchResult;
    try {
      prefetched = await prefetchGrepCandidates({
        pool: ctx.pool,
        pageCache: ctx.pageCache,
        tree: ctx.tree,
        pattern: effectivePattern,
        path: target,
        isRegex,
      });
    } catch (e: unknown) {
      // Coarse-filter SQL failed (e.g., invalid POSIX regex). Surface as a grep
      // error rather than silently walking every file under the original target.
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`grep: prefetch failed: ${reason}`, { cause: e });
    }
    ctx.fs.accDbMs += prefetched.db_ms;
    if (prefetched.candidate_paths.length === 0) {
      // Coarse filter narrowed to zero. Fall through unnarrowed so verbs like
      // -c (emits <path>:0 per file) and -L (emits non-matching files) produce
      // semantically correct output. Surface a stderr signal so the agent can
      // pivot away from constructs the trigram index can't translate.
      return {
        cmd,
        prependStderr:
          'note: coarse filter returned 0 candidates; pattern may scan unfiltered ' +
          '(constructs like \\b, -P, or sub-3-char substrings bypass the trigram index)\n',
      };
    }
    return {
      cmd: reassemble([...narrowGrepArgv(headArgv, prefetched.candidate_paths), ...tailArgv]),
    };
  }

  // cat, find, stdin filters — pass through unchanged.
  return { cmd };
}

// Replace grep's directory/file target with the prefetched candidate paths.
// If no target was specified, the candidates are appended.
function narrowGrepArgv(argv: string[], candidatePaths: string[]): string[] {
  const targetIdx = findGrepTargetIdx(argv);
  if (targetIdx === -1) return [...argv, ...candidatePaths];
  return [...argv.slice(0, targetIdx), ...candidatePaths, ...argv.slice(targetIdx + 1)];
}

// Index in argv of grep's path-target positional (the second positional after
// the verb; first is the pattern). Returns -1 if no target was provided.
function findGrepTargetIdx(argv: string[]): number {
  let positionals = 0;
  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a.startsWith('-') && a !== '-') {
      i++;
      if (GREP_OPTS_TAKING_VALUE.has(a) && i < argv.length) i++;
      continue;
    }
    if (positionals === 1) return i;
    positionals++;
    i++;
  }
  return -1;
}

function injectFFlag(argv: string[]): string[] {
  // If any flag arg already contains 'F', leave it alone.
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--') && a.includes('F')) return argv;
    if (a === '--classify' || a === '-F') return argv;
  }
  // Insert -F right after the verb so combined flags downstream aren't disturbed.
  return [argv[0]!, '-F', ...argv.slice(1)];
}

function stripNonSlashMarkers(stdout: string): string {
  // ls -F appends @ (symlink), * (executable), | (FIFO), = (socket), > (door),
  // and / (directory). Keep only `/`.
  return stdout
    .split('\n')
    .map((line) => line.replace(/([@*|=>])(?=\s|$)/g, ''))
    .join('\n');
}

export function parseGrepPatternAndPath(argv: string[], cwd: string): { pattern: string; target: string } {
  // Skip verb (argv[0]) and any flags. The first non-flag positional is the pattern;
  // the second is the path target. If no path target, default to cwd.
  const positional: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--') { i++; break; }
    if (a.startsWith('-') && a !== '-') {
      i++;
      if (GREP_OPTS_TAKING_VALUE.has(a) && i < argv.length) i++;
      continue;
    }
    positional.push(a);
    i++;
  }
  while (i < argv.length) positional.push(argv[i++]!);
  const pattern = positional[0] ?? '';
  const target = positional[1] ?? cwd;
  return { pattern, target };
}

// True if argv carries `-E` (in short-flag clusters) or `--extended-regexp`.
function argvHasERegexFlag(argv: string[]): boolean {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) {
      if (a === '--extended-regexp') return true;
      continue;
    }
    if (a.includes('E')) return true;
  }
  return false;
}

// Minimal shell-arg reassembly. Single-quote-escape args that contain whitespace
// or shell metacharacters; pass safe identifiers through unchanged.
function reassemble(argv: string[]): string {
  return argv.map(sqEscape).join(' ');
}

// Shell operator tokens that shellSplit emits as standalone argv entries.
// They must pass through reassemble unquoted so just-bash parses them as
// operators, not literal positional path arguments.
const SHELL_OPERATORS = new Set(['|', '&&', '||', ';', '>', '<', '>>', '<<']);

function sqEscape(s: string): string {
  if (s === '') return "''";
  if (SHELL_OPERATORS.has(s)) return s;
  if (/^[A-Za-z0-9_./@:=+,%-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Minimal shell-arg tokenizer: handles single+double quoted strings, splits on
// unquoted whitespace. No backslash escapes, $-expansion, or command
// substitution — adequate for the 5-verb surface; will mis-parse exotic argv.
function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === null && (c === '"' || c === "'")) { quote = c as '"' | "'"; continue; }
    if (quote !== null && c === quote) { quote = null; continue; }
    if (quote === null && /\s/.test(c)) {
      if (cur.length > 0) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
