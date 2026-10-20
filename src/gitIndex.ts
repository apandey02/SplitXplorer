import * as path from 'path';
import { execFile } from 'child_process';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

// Repo-relative, forward slashes, no trailing slash; lowercased on Windows
// because NTFS paths are case-insensitive.
function normalize(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * Snapshot of which paths in a repo are gitignored.
 *
 * Built from a single `git ls-files --others --ignored --exclude-standard --directory`
 * call: git applies every .gitignore, .git/info/exclude and core.excludesFile, skips
 * tracked files (a tracked file is never "ignored"), and collapses fully ignored
 * folders such as node_modules/ into one entry, so this stays fast on big repos.
 */
export class GitIgnoreIndex {
  private readonly ignored = new Set<string>();
  /** Folders that are not ignored themselves but contain ignored entries. */
  private readonly containers = new Set<string>();

  private constructor(readonly repoRoot: string | undefined) {}

  static empty(): GitIgnoreIndex {
    return new GitIgnoreIndex(undefined);
  }

  static async load(folder: string): Promise<GitIgnoreIndex> {
    let root: string;
    try {
      root = (await git(['rev-parse', '--show-toplevel'], folder)).trim();
    } catch {
      return GitIgnoreIndex.empty(); // not a git repo, or git not installed
    }

    const index = new GitIgnoreIndex(root);
    const out = await git(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      root
    );
    for (const raw of out.split('\0')) {
      if (!raw) continue;
      const rel = normalize(raw);
      index.ignored.add(rel);
      for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
        const parent = rel.slice(0, i);
        if (index.containers.has(parent)) break; // its ancestors are already recorded
        index.containers.add(parent);
      }
    }
    return index;
  }

  get isRepo(): boolean {
    return this.repoRoot !== undefined;
  }

  private rel(fsPath: string): string | undefined {
    if (!this.repoRoot) return undefined;
    const rel = path.relative(this.repoRoot, fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return normalize(rel);
  }

  /** True if this exact path is ignored. Callers propagate ignored-ness from parents. */
  isIgnored(fsPath: string): boolean {
    const rel = this.rel(fsPath);
    return rel !== undefined && this.ignored.has(rel);
  }

  /** True if this folder has ignored entries somewhere beneath it. */
  containsIgnored(fsPath: string): boolean {
    const rel = this.rel(fsPath);
    return rel === undefined ? this.isRepo && this.ignored.size > 0 : this.containers.has(rel);
  }
}
