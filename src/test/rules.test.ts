// Plain-Node check of section rules: `npm run test:rules`.
import * as assert from 'assert';
import { PathSet, isVisible, pathKey, withoutAtOrBelow } from '../rules';

const k = (p: string) => pathKey(p, false);
const set = (...ps: string[]) => new PathSet(ps.map(k));

// PathSet basics.
const s = set('/ws/src', '/ws/docs/a.md');
assert.ok(s.covers(k('/ws/src')), 'entry covers itself');
assert.ok(s.covers(k('/ws/src/deep/x.ts')), 'entry covers descendants');
assert.ok(!s.covers(k('/ws/srcx')), 'sibling with shared prefix is not covered');
assert.ok(s.hasBelow(k('/ws/docs')), 'ancestor of an entry');
assert.ok(!s.hasBelow(k('/ws/docs/a.md')), 'entry itself has nothing below');
assert.strictEqual(s.coverDepth(k('/ws/src/x')), k('/ws/src').split('/').length);

// No rules: base filter decides.
const none = set();
assert.ok(isVisible(k('/ws/a'), false, true, none, none));
assert.ok(!isVisible(k('/ws/a'), false, false, none, none));

// Include brings a hidden path in, and its folders stay reachable.
const inc = set('/ws/hidden/file.ts');
assert.ok(isVisible(k('/ws/hidden/file.ts'), false, false, inc, none), 'included file shows');
assert.ok(isVisible(k('/ws/hidden'), true, false, inc, none), 'its parent folder shows');
assert.ok(!isVisible(k('/ws/hidden/other.ts'), false, false, inc, none), 'siblings stay hidden');

// Exclude hides, but a deeper include wins and keeps its folder reachable.
const exc = set('/ws/src');
const deeper = set('/ws/src/keep.ts');
assert.ok(!isVisible(k('/ws/src/a.ts'), false, true, none, exc), 'excluded subtree hidden');
assert.ok(isVisible(k('/ws/src'), true, true, deeper, exc), 'excluded folder shows to reach an include');
assert.ok(isVisible(k('/ws/src/keep.ts'), false, true, deeper, exc), 'deeper include wins');
assert.ok(!isVisible(k('/ws/src/drop.ts'), false, true, deeper, exc), 'rest of excluded folder hidden');

// A deeper exclude beats a shallower include.
assert.ok(!isVisible(k('/ws/src/x'), false, false, set('/ws/src'), set('/ws/src/x')));
// Same path in both: include wins.
assert.ok(isVisible(k('/ws/src'), true, false, set('/ws/src'), set('/ws/src')));

// Windows keys ignore case and separators.
assert.strictEqual(pathKey('C:\\Repo\\Src\\', true), 'c:/repo/src');

// Rule cleanup removes the target and everything under it, nothing else.
assert.deepStrictEqual(
  withoutAtOrBelow(['/ws/a', '/ws/a/b', '/ws/ab', '/ws/c'], k('/ws/a'), k),
  ['/ws/ab', '/ws/c']
);

console.log('rules: all checks passed');
