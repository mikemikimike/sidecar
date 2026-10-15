import type { RegisteredTool } from '../../src/agent/tools/shared.js';

/**
 * Make paired canary runs reproducible: the same command must produce the same
 * tool output in both arms, or the arms diverge for reasons that have nothing
 * to do with the treatment.
 *
 * Measured on the #155 A/B (2026-10-14, swe-runs/diverge_first.py): with seed,
 * engine and code identical, 73 of 126 task pairs that the treatment never
 * touched still diverged. 71 of the 73 first differed at a TOOL RESULT and one
 * at the model -- Ollama is deterministic, the environment is not. The volatile
 * text, in the order it occurred:
 *   - test durations: `Ran 127 tests in 5.986s`, `(0.24 seconds)`, pytest's
 *     `=== 1 error in 0.28s ===`, whose `=` padding also tracks the digits;
 *   - sympy's runner printing a fresh `random seed:` and PYTHONHASHSEED;
 *   - `git_commit` SHAs, which hash the commit timestamp.
 * Those divergences netted -22 successful edits in the null pairs and swamped
 * the effect the A/B was measuring.
 *
 * Two parts, both harness-only (product code and what file reads return are
 * untouched):
 *   - STABLE_TOOL_ENV pins what can be pinned at the source, for every
 *     subprocess the tools start;
 *   - stableToolOutput rewrites what cannot (a duration) to a fixed value in
 *     the output of the process-running tools, before the model sees it.
 * The numbers are replaced, not deleted, so the output still reads normally.
 */

/** Pinned for every tool subprocess: fixed git dates make commit SHAs reproducible; a fixed hash seed fixes sympy's banner and Python dict/set order. */
export const STABLE_TOOL_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  PYTHONHASHSEED: '0',
};

/** The tools whose output is a process's output. File reads and searches are never rewritten: an edit is matched against what the model read. */
export const STABLE_OUTPUT_TOOLS: readonly string[] = ['run_command', 'run_tests', 'git_commit'];

const FIXED_DURATION = '0.00';
/** pytest pads its summary separators to the terminal width; the harness's runs use 80. */
const SEPARATOR_WIDTH = 80;

const SUMMARY_WORDS = /\b(passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|no tests ran)\b/;

/** Rewrite run-to-run volatile text in a process's output to fixed values. */
export function stableToolOutput(output: string): string {
  return output
    .split('\n')
    .map((raw) => {
      const cr = raw.endsWith('\r') ? '\r' : '';
      let line = cr ? raw.slice(0, -1) : raw;
      line = line
        // unittest / django: `Ran 127 tests in 5.986s`
        .replace(/\b(Ran \d+ tests? in )\d+(?:\.\d+)?s\b/, `$1${FIXED_DURATION}s`)
        // sympy, tox: `(0.24 seconds)`
        .replace(/\(\d+(?:\.\d+)? seconds\)/g, `(${FIXED_DURATION} seconds)`)
        // sympy's runner banner
        .replace(/^(random seed:\s+)\d+$/, '$112345678');
      // pytest / sympy summaries: `3 passed in 0.12s`, `1 error in 3.56 seconds (0:00:03)`
      if (SUMMARY_WORDS.test(line)) {
        line = line.replace(/( in )\d+(?:\.\d+)?(s| seconds)( \(\d+:\d\d:\d\d\))?/, `$1${FIXED_DURATION}$2`);
        // ...and re-pad a `=== ... ===` separator to a fixed width, since its padding tracked the digits.
        const sep = /^=+ (.+) =+$/.exec(line);
        if (sep) {
          const pad = Math.max(2, SEPARATOR_WIDTH - sep[1].length - 2);
          line = `${'='.repeat(Math.floor(pad / 2))} ${sep[1]} ${'='.repeat(Math.ceil(pad / 2))}`;
        }
      }
      return line + cr;
    })
    .join('\n');
}

/** Copies of the process-running tools whose output is passed through stableToolOutput. Pass as AgentOptions.extraTools, which the executor resolves before the registry. */
export function stableOutputTools(find: (name: string) => RegisteredTool | undefined): RegisteredTool[] {
  return STABLE_OUTPUT_TOOLS.flatMap((name) => {
    const tool = find(name);
    if (!tool) return [];
    return [{ ...tool, executor: async (input, context) => stableToolOutput(await tool.executor(input, context)) }];
  });
}
