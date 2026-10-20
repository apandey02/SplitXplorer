// Plain-Node check of GitIgnoreIndex against a throwaway repo: `npm run test:index`.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitIgnoreIndex } from '../gitIndex';

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'splitxplorer-'));
  const write = (rel: string, body = '') => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  const p = (rel: string) => path.join(repo, rel);

  execFileSync('git', ['init', '-q'], { cwd: repo });
  write('.gitignore', 'node_modules/\n*.log\nsrc/generated.js\ntracked.log\n');
  write('README.md');
  write('src/index.js');
  write('src/generated.js');
  write('src/deep/nested/debug.log');
  write('node_modules/pkg/index.js');
  write('tracked.log');
  // Force-added files are tracked, so git no longer treats them as ignored.
  execFileSync('git', ['add', '-f', 'tracked.log'], { cwd: repo });

  const idx = await GitIgnoreIndex.load(repo);
  assert.ok(idx.isRepo);

  assert.ok(idx.isIgnored(p('node_modules')), 'node_modules ignored');
  assert.ok(idx.isIgnored(p('src/generated.js')), 'src/generated.js ignored');
  assert.ok(idx.isIgnored(p('src/deep/nested/debug.log')), 'nested log ignored');
  assert.ok(!idx.isIgnored(p('src/index.js')), 'src/index.js not ignored');
  assert.ok(!idx.isIgnored(p('README.md')), 'README not ignored');
  assert.ok(!idx.isIgnored(p('tracked.log')), 'tracked file is not ignored');
  assert.ok(!idx.isIgnored(p('.gitignore')), '.gitignore not ignored');

  assert.ok(idx.containsIgnored(p('src')), 'src contains ignored');
  assert.ok(idx.containsIgnored(p('src/deep')), 'src/deep contains ignored');
  assert.ok(!idx.containsIgnored(p('node_modules')), 'node_modules is ignored itself, not a container');

  const notRepo = await GitIgnoreIndex.load(fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-')));
  assert.ok(!notRepo.isRepo);
  assert.ok(!notRepo.isIgnored(p('anything')));

  fs.rmSync(repo, { recursive: true, force: true });
  console.log('gitIndex: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
