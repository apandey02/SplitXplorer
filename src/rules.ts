// Section filtering rules. No vscode dependency so it can be tested with plain Node.

/** Kinds of section the + button can add. */
export type SectionKind = 'acknowledged' | 'ignored' | 'all' | 'custom';

/** Persisted shape of one Explorer section. Paths are URI strings. */
export interface SectionConfig {
  /** Which pre-declared view slot (1-based) shows this section. */
  slot: number;
  kind: SectionKind;
  name: string;
  /** Files or folders always shown (a folder brings its whole subtree). */
  include: string[];
  /** Files or folders always hidden. */
  exclude: string[];
  /** Globs relative to each workspace folder, custom sections only. */
  globs: string[];
}

/**
 * Comparison key for a path: forward slashes, no trailing slash, lowercased on
 * Windows because NTFS paths are case-insensitive.
 */
export function pathKey(p: string, caseInsensitive = process.platform === 'win32'): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

/** A set of paths that answers "is this path, or an ancestor of it, in the set" quickly. */
export class PathSet {
  private readonly entries = new Set<string>();
  private readonly ancestors = new Set<string>();

  constructor(keys: Iterable<string> = []) {
    for (const k of keys) this.add(k);
  }

  add(key: string): void {
    this.entries.add(key);
    for (let i = key.lastIndexOf('/'); i > 0; i = key.lastIndexOf('/', i - 1)) {
      const parent = key.slice(0, i);
      if (this.ancestors.has(parent)) break; // its ancestors are already recorded
      this.ancestors.add(parent);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Depth of the deepest entry equal to or above key, or -1 when none covers it. */
  coverDepth(key: string): number {
    for (let k = key; ; ) {
      if (this.entries.has(k)) return k.split('/').length;
      const i = k.lastIndexOf('/');
      if (i <= 0) return -1;
      k = k.slice(0, i);
    }
  }

  covers(key: string): boolean {
    return this.coverDepth(key) >= 0;
  }

  /** True if some entry sits strictly below key. */
  hasBelow(key: string): boolean {
    return this.ancestors.has(key);
  }
}

/**
 * Decides whether a path appears in a section.
 *
 * The deepest include or exclude rule covering the path wins (include on a tie).
 * With no rule, the section's base filter decides. Folders also appear when an
 * include sits somewhere beneath them, so the included entry stays reachable.
 */
export function isVisible(
  key: string,
  isDir: boolean,
  base: boolean,
  include: PathSet,
  exclude: PathSet
): boolean {
  const inc = include.coverDepth(key);
  const exc = exclude.coverDepth(key);
  if (inc >= 0 && inc >= exc) return true;
  const leadsToInclude = isDir && include.hasBelow(key);
  if (exc >= 0) return leadsToInclude;
  return base || leadsToInclude;
}

/** True if key is target itself or lies beneath it. */
export function isAtOrBelow(key: string, target: string): boolean {
  return key === target || key.startsWith(target + '/');
}

/** Removes the entries of list (raw paths) that are target or lie beneath it. */
export function withoutAtOrBelow(list: string[], target: string, keyOf: (p: string) => string): string[] {
  return list.filter((p) => !isAtOrBelow(keyOf(p), target));
}
