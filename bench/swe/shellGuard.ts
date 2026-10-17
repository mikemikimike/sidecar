import type { RegisteredTool, ToolExecutorContext } from '../../src/agent/tools/shared.js';

/** The tools that run commands in the agent's persistent shell. */
export const SHELL_GUARD_TOOLS: readonly string[] = ['run_command', 'run_tests'];

/** The slice of ShellSession the guard needs. */
export interface GuardShell {
  execute(
    command: string,
    options?: { timeout?: number },
  ): Promise<{ stdout: string; exitCode: number; timedOut?: boolean }>;
}

const PROBE_TIMEOUT_MS = 30_000;

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The note appended to a result whose command left the clone. */
export function returnedNote(left: string): string {
  return (
    `\n\n[harness] This command left the shell in ${left}, outside the repository. ` +
    `The shell has been moved back to the repository root; later commands run from there.`
  );
}

/**
 * Keeps the agent's shell inside the task clone (#196).
 *
 * The product's shell session keeps its working directory between commands on
 * purpose (shellSession.ts: cwd is "legitimate persistence"), and the harness
 * added nothing on top. So one `cd /tmp` sent every later command to /tmp, and
 * a `cd / && find .` scanned the host's whole disk -- 297 s of a 351 s run.
 *
 * After each command this asks the shell where it is. Inside the clone -- the
 * root or any subdirectory -- nothing happens, so a `cd src` persists exactly
 * as in the product. Outside it, the shell is moved back to the root and the
 * result says so, so the model is not left to discover it. Comparison is on
 * `pwd -P` from the shell itself, so the shell's own path spelling (Git Bash's
 * /c/... on Windows) never has to be translated.
 *
 * It contains a session, not a command: `cd / && find .` still runs to
 * completion inside that one command. Isolating the host is a separate
 * decision (#196).
 */
export class ShellRootGuard {
  private rootPwd: string | null | undefined;

  constructor(private readonly root: string) {}

  /** The clone root as the shell spells it; null when the shell cannot tell us (no POSIX `pwd`). */
  private async resolveRoot(shell: GuardShell): Promise<string | null> {
    if (this.rootPwd === undefined) {
      const r = await shell.execute(`cd -- ${singleQuote(this.root.replace(/\\/g, '/'))} && pwd -P`, {
        timeout: PROBE_TIMEOUT_MS,
      });
      // A probe that timed out (a loaded machine) says nothing about the shell:
      // leave it unresolved and ask again next command, rather than caching
      // "no POSIX pwd" and switching the guard off for the rest of the task.
      if (r.timedOut) return null;
      const out = r.stdout.trim();
      this.rootPwd = r.exitCode === 0 && out.startsWith('/') ? out : null;
    }
    return this.rootPwd;
  }

  /** Call before the first command, while the shell is still at the root. */
  async init(shell: GuardShell): Promise<void> {
    await this.resolveRoot(shell);
  }

  /** After a command: the note to append, or '' when the shell is still inside the clone. */
  async afterCommand(shell: GuardShell): Promise<string> {
    const root = await this.resolveRoot(shell);
    if (!root) return '';
    const r = await shell.execute('pwd -P', { timeout: PROBE_TIMEOUT_MS });
    const here = r.stdout.trim();
    if (r.exitCode !== 0 || !here) return '';
    if (here === root || here.startsWith(root.endsWith('/') ? root : `${root}/`)) return '';
    await shell.execute(`cd -- ${singleQuote(root)}`, { timeout: PROBE_TIMEOUT_MS });
    return returnedNote(here);
  }
}

/**
 * `tools` with run_command / run_tests wrapped by `guard`. Takes the tools
 * already chosen for extraTools (e.g. the stable-output copies) and falls back
 * to the registry for any guarded tool not among them.
 */
export function shellGuardTools(
  tools: readonly RegisteredTool[],
  find: (name: string) => RegisteredTool | undefined,
  guard: ShellRootGuard,
  getShell: (context?: ToolExecutorContext) => GuardShell | undefined = (context) =>
    context?.toolRuntime?.getShellSession(context?.config),
): RegisteredTool[] {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  for (const name of SHELL_GUARD_TOOLS) {
    const tool = byName.get(name) ?? find(name);
    if (!tool) continue;
    byName.set(name, {
      ...tool,
      executor: async (input, context) => {
        const shell = getShell(context);
        if (shell) await guard.init(shell);
        const output = await tool.executor(input, context);
        return shell ? output + (await guard.afterCommand(shell)) : output;
      },
    });
  }
  return [...byName.values()];
}
