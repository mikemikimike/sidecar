import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureDiff } from './captureDiff.js';

// A real repository: the bug was git's own behaviour (`git add -A -- <paths>`
// exits 128 on one bad pathspec and stages nothing), so a mock would prove
// nothing.
let dir: string;
let base: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-diff-'));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  write('pkg/mod.py', 'x = 1\n');
  write('pkg/gone.py', 'y = 2\n');
  write('.gitignore', 'pkg/_version.py\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD').trim();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('captureDiff', () => {
  // #1 of the ticket: astropy-14365 -- a refused absolute write_file path sat in
  // touchedPaths beside the real fix, and the whole patch came back empty.
  it('keeps the valid edit when another touched path is outside the repo', () => {
    write('pkg/mod.py', 'x = 2\n');
    const outside = path.join(os.tmpdir(), 'test_lowercase_qdp.py');
    const { patch, dropped } = captureDiff(dir, base, ['pkg/mod.py', outside, '../escape.py']);
    expect(patch).toContain('-x = 1');
    expect(patch).toContain('+x = 2');
    expect(dropped).toEqual([
      { path: outside, reason: 'outside-repo' },
      { path: '../escape.py', reason: 'outside-repo' },
    ]);
  });

  // #2 of the ticket: astropy-12907 -- scratch tests written, then `rm`'d by a
  // shell command, still in touchedPaths.
  it('keeps the valid edit when a scratch file was written and later removed', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('test_bug.py', 'assert False\n');
    fs.rmSync(path.join(dir, 'test_bug.py'));
    const { patch, dropped } = captureDiff(dir, base, ['test_bug.py', 'pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(dropped).toEqual([{ path: 'test_bug.py', reason: 'missing-untracked' }]);
  });

  it('shows a tracked file the agent deleted as a deletion', () => {
    fs.rmSync(path.join(dir, 'pkg/gone.py'));
    const { patch, dropped } = captureDiff(dir, base, ['pkg/gone.py']);
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('-y = 2');
    expect(dropped).toEqual([]);
  });

  // matplotlib-18869: the only edit was to an untracked, gitignored generated file.
  it('drops an untracked ignored file instead of failing the add', () => {
    write('pkg/_version.py', 'v = 1\n');
    write('pkg/mod.py', 'x = 2\n');
    const { patch, dropped } = captureDiff(dir, base, ['pkg/_version.py', 'pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(patch).not.toContain('_version');
    expect(dropped).toEqual([{ path: 'pkg/_version.py', reason: 'ignored' }]);
  });

  it('includes a new untracked file the agent kept', () => {
    write('pkg/new.py', 'z = 3\n');
    expect(captureDiff(dir, base, ['pkg/new.py']).patch).toContain('+z = 3');
  });

  it('still captures a committed fix, and still ignores unrelated drift', () => {
    write('pkg/mod.py', 'x = 2\n');
    git('commit', '-qam', 'agent committed');
    write('pkg/gone.py', 'drift\n');
    const { patch } = captureDiff(dir, base, ['pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(patch).not.toContain('drift');
  });

  it('returns an empty patch for edited-then-reverted files and when nothing survives', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/mod.py', 'x = 1\n');
    expect(captureDiff(dir, base, ['pkg/mod.py']).patch).toBe('');
    expect(captureDiff(dir, base, ['/tmp/a.py', 'never-written.py'])).toEqual({
      patch: '',
      dropped: [
        { path: '/tmp/a.py', reason: 'outside-repo' },
        { path: 'never-written.py', reason: 'missing-untracked' },
      ],
    });
  });

  it('accepts backslash and absolute in-repo spellings of a path', () => {
    write('pkg/mod.py', 'x = 2\n');
    const { patch } = captureDiff(dir, base, [path.join(dir, 'pkg', 'mod.py')]);
    expect(patch).toContain('+x = 2');
  });
});
