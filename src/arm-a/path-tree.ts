interface DirNode {
  kind: 'dir';
  children: Map<string, Node>;
}

interface FileNode {
  kind: 'file';
  slug: string;
}

type Node = DirNode | FileNode;

function isDir(n: Node | undefined): n is DirNode { return n?.kind === 'dir'; }
function isFile(n: Node | undefined): n is FileNode { return n?.kind === 'file'; }

function splitAbs(absPath: string): string[] {
  if (!absPath.startsWith('/')) throw new Error(`PathTree requires absolute path, got: ${absPath}`);
  const parts = absPath.replace(/\/+$/, '').split('/').slice(1);
  return parts.filter((p) => p.length > 0);
}

export class PathTree {
  private readonly root: DirNode = { kind: 'dir', children: new Map() };
  // Slugs that are also a directory prefix of another slug; routed to
  // `/<slug>/index.mdx` so the file and dir coexist.
  private readonly sectionIndexSlugs: Set<string> = new Set();

  static fromDocPaths(rows: ReadonlyArray<{ slug: string }>): PathTree {
    const t = new PathTree();
    // A strict FS tree cannot hold a file and a directory at the same path,
    // so any slug that is also a prefix of another slug is synthesized as
    // `<slug>/index`. The original slug is preserved on FileNode.slug for
    // the chunk lookup.
    const slugSet = new Set(rows.map((r) => r.slug));
    for (const slug of slugSet) {
      const parts = slug.split('/');
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (slugSet.has(prefix)) t.sectionIndexSlugs.add(prefix);
      }
    }
    for (const { slug } of rows) {
      const fsPath = t.sectionIndexSlugs.has(slug) ? `${slug}/index` : slug;
      t.add(fsPath, slug);
    }
    return t;
  }

  isSectionIndex(slug: string): boolean {
    return this.sectionIndexSlugs.has(slug);
  }

  // Convert a doc_paths slug to its canonical FS path: section-index slugs
  // → `<slug>/index.mdx`; others → `<slug>.mdx`. Used by grep prefetch so
  // the emitted candidate paths match the resolver's view of the tree.
  slugToFsPath(slug: string): string {
    return this.isSectionIndex(slug) ? `/${slug}/index.mdx` : `/${slug}.mdx`;
  }

  add(path: string, slug: string = path): void {
    const parts = path.split('/');
    let cursor: DirNode = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = cursor.children.get(part);
      if (!next) {
        const dir: DirNode = { kind: 'dir', children: new Map() };
        cursor.children.set(part, dir);
        cursor = dir;
      } else if (isDir(next)) {
        cursor = next;
      } else {
        throw new Error(`PathTree: path '${path}' collides with existing file at '${part}'.`);
      }
    }
    const leafName = parts[parts.length - 1]!;
    if (cursor.children.has(leafName)) throw new Error(`PathTree: path '${path}' duplicates existing path.`);
    cursor.children.set(leafName, { kind: 'file', slug });
  }

  private resolveNode(absPath: string): Node | undefined {
    if (absPath === '/' || absPath === '') return this.root;
    const parts = splitAbs(absPath);
    let cursor: Node = this.root;
    for (const part of parts) {
      if (!isDir(cursor)) return undefined;
      // `.mdx`-suffixed segments must resolve to FileNode only; bare
      // segments resolve to either kind. Falling back to a DirNode on
      // `<slug>.mdx` would let the same section-index slug resolve as both
      // file and walkable dir, which doubles grep walks.
      if (part.endsWith('.mdx')) {
        const stripped = part.slice(0, -4);
        const next = cursor.children.get(stripped);
        if (!next || !isFile(next)) return undefined;
        cursor = next;
      } else {
        const next = cursor.children.get(part);
        if (!next) return undefined;
        cursor = next;
      }
    }
    return cursor;
  }

  ls(absPath: string): string[] {
    const node = this.resolveNode(absPath);
    if (!node) throw new Error(`ENOENT: ${absPath}`);
    if (isFile(node)) throw new Error(`ENOTDIR: ${absPath}`);
    // FS-shape labels (/<dir>/, <file>.mdx) — idempotent through just-bash ls -F.
    return [...node.children.entries()]
      .map(([name, child]) => (isDir(child) ? `${name}/` : `${name}.mdx`))
      .sort();
  }

  isDirectory(absPath: string): boolean {
    const node = this.resolveNode(absPath);
    return !!node && isDir(node);
  }

  isFile(absPath: string): boolean {
    const node = this.resolveNode(absPath);
    return !!node && isFile(node);
  }

  resolveFile(absPath: string): string | null {
    const node = this.resolveNode(absPath);
    return node && isFile(node) ? node.slug : null;
  }

  find(absPath: string): string[] {
    const node = this.resolveNode(absPath);
    if (!node) throw new Error(`ENOENT: ${absPath}`);
    const out: string[] = [];
    const prefix = absPath === '/' ? '' : absPath.replace(/\/+$/, '');
    const walk = (n: Node, parentAbs: string): void => {
      if (isFile(n)) { out.push(parentAbs); return; }
      for (const [name, child] of n.children) {
        const next = isDir(child) ? `${parentAbs}/${name}` : `${parentAbs}/${name}.mdx`;
        walk(child, next);
      }
    };
    walk(node, prefix);
    return out;
  }
}
