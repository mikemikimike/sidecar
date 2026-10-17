import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShellSession } from '../../src/terminal/shellSession.js';
import type { RegisteredTool } from '../../src/agent/tools/shared.js';
import { ShellRootGuard, shellGuardTools, returnedNote } from './shellGuard.js';

// A real ShellSession: the bug is the session's own cwd persistence, so the
// guard is only proven against the real thing (Git Bash on Windows, bash/zsh
// elsewhere).
let root: string;
let outside: string;
let session: ShellSession;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-root-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'mod.py'), 'x = 1\n');
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-outside-')));
  session = new ShellSession(root);
});

afterEach(() => {
  session.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const sh = (cmd: string) => session.execute(cmd, { timeout: 60_000 });
const posix = (p: string) => p.replace(/\\/g, '/');

// Real Git Bash sessions start slowly on a loaded machine (the pre-commit hook
// runs these beside the whole suite), so the 5 s default is too tight.
describe('ShellRootGuard (#196)', { timeout: 30_000 }, () => {
  it('moves the shell back after a command leaves the clone, so the next relative command runs in the clone', async () => {
    const guard = new ShellRootGuard(root);
    await guard.init(session);
    await sh(`cd -- '${posix(outside)}'`);
    const note = await guard.afterCommand(session);
    expect(note).toContain('outside the repository');
    expect(note).toContain('moved back to the repository root');
    expect((await sh('ls src')).stdout).toContain('mod.py');
  });

  it('leaves a cd inside the clone alone, as the product does', async () => {
    const guard = new ShellRootGuard(root);
    await guard.init(session);
    await sh('cd src');
    expect(await guard.afterCommand(session)).toBe('');
    expect((await sh('ls')).stdout).toContain('mod.py');
  });

  it('treats a sibling directory sharing the root as a prefix as outside', async () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling);
    try {
      const guard = new ShellRootGuard(root);
      await guard.init(session);
      await sh(`cd -- '${posix(sibling)}'`);
      expect(await guard.afterCommand(session)).not.toBe('');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('wraps run_command and run_tests, keeps other extra tools, and appends the note to the result', async () => {
    const guard = new ShellRootGuard(root);
    const mk = (name: string, run: () => Promise<string>): RegisteredTool =>
      ({ definition: { name }, executor: run }) as unknown as RegisteredTool;
    const runCommand = mk('run_command', async () => {
      await sh(`cd -- '${posix(outside)}'`);
      return 'ran';
    });
    const gitCommit = mk('git_commit', async () => 'committed');
    const tools = shellGuardTools(
      [runCommand, gitCommit],
      (name) => (name === 'run_tests' ? mk('run_tests', async () => 'tests') : undefined),
      guard,
      () => session,
    );
    expect(tools.map((t) => t.definition.name).sort()).toEqual(['git_commit', 'run_command', 'run_tests']);
    const out = await tools.find((t) => t.definition.name === 'run_command')!.executor({}, undefined as never);
    expect(out.startsWith('ran')).toBe(true);
    expect(out).toContain(returnedNote('').trim().slice(0, 30));
    expect(await tools.find((t) => t.definition.name === 'git_commit')!.executor({}, undefined as never)).toBe(
      'committed',
    );
    expect((await sh('ls src')).stdout).toContain('mod.py');
  });

  it('retries a probe that timed out instead of switching the guard off', async () => {
    const guard = new ShellRootGuard(root);
    let calls = 0;
    const flaky = {
      execute: async (cmd: string) => {
        calls++;
        if (calls === 1) return { stdout: '', exitCode: 124, timedOut: true };
        return { stdout: cmd.startsWith('cd --') ? '/repo' : '/elsewhere', exitCode: 0 };
      },
    };
    await guard.init(flaky);
    expect(await guard.afterCommand(flaky)).toContain('outside the repository');
  });

  it('does nothing when the shell cannot report a POSIX path', async () => {
    const guard = new ShellRootGuard(root);
    const fake = { execute: async () => ({ stdout: 'C:\\somewhere', exitCode: 0 }) };
    await guard.init(fake);
    expect(await guard.afterCommand(fake)).toBe('');
  });
});
