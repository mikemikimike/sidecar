import { describe, it, expect, vi } from 'vitest';
import { stableToolOutput, stableOutputTools, STABLE_TOOL_ENV } from './stableToolOutput.js';
import type { RegisteredTool } from '../../src/agent/tools/shared.js';

// Every pair below is a real divergence from the #155 A/B (2026-10-14): the
// same command, same seed and engine, two different outputs. Each pair must
// come out identical.
const PAIRS: Array<[string, string]> = [
  ['Ran 127 tests in 5.986s\r\n\r\nOK', 'Ran 127 tests in 6.014s\r\n\r\nOK'],
  ['random seed:        72480569\r', 'random seed:        80336159\r'],
  ['evaluation failed :( (0.24 seconds)', 'evaluation failed :( (0.14 seconds)'],
  ['py39: FAIL code 2 (0.06 seconds)', 'py39: FAIL code 2 (0.03 seconds)'],
  [
    '============================ no tests ran in 0.04s ============================',
    '============================ no tests ran in 0.02s ============================',
  ],
  [
    '=========================== no tests ran in 14.56s ============================\r',
    '============================ no tests ran in 8.55s ============================\r',
  ],
  [
    '======================== 2 warnings, 1 error in 0.28s =========================',
    '======================== 2 warnings, 1 error in 0.27s =========================',
  ],
  [
    '=========================== 1 error in 3.56 seconds ===========================',
    '=========================== 1 error in 3.65 seconds ===========================',
  ],
  ['3 passed in 0.12s', '3 passed in 1.07s'],
];

describe('stableToolOutput', () => {
  it.each(PAIRS)('makes a measured divergence identical: %s', (a, b) => {
    expect(stableToolOutput(a)).toBe(stableToolOutput(b));
  });

  it('keeps the output readable: numbers are replaced, line endings and widths kept', () => {
    expect(stableToolOutput('Ran 127 tests in 5.986s\r\nOK\r\n')).toBe('Ran 127 tests in 0.00s\r\nOK\r\n');
    const sep = stableToolOutput('=========================== no tests ran in 14.56s ============================');
    expect(sep).toBe(`${'='.repeat(28)} no tests ran in 0.00s ${'='.repeat(29)}`);
    expect(sep.length).toBe(80);
  });

  it('leaves everything else alone: counts, test names, code, unrelated numbers', () => {
    const text = [
      'FAILED tests/test_x.py::test_timeout_5s - AssertionError: 3 != 4',
      'def wait(): time.sleep(2.5)  # seconds',
      'Ran out of retries after 3 attempts',
      '127 items collected',
    ].join('\n');
    expect(stableToolOutput(text)).toBe(text);
  });
});

describe('stableOutputTools', () => {
  it('wraps only the process-running tools, keeping their definition and approval', async () => {
    const run: RegisteredTool = {
      definition: { name: 'run_command', description: 'd', input_schema: { type: 'object', properties: {} } },
      executor: vi.fn(async () => 'Ran 3 tests in 0.912s'),
      requiresApproval: true,
    };
    const tools = stableOutputTools((n) => (n === 'run_command' ? run : undefined));
    expect(tools.map((t) => t.definition.name)).toEqual(['run_command']);
    expect(tools[0].requiresApproval).toBe(true);
    expect(await tools[0].executor({ command: 'x' })).toBe('Ran 3 tests in 0.00s');
    expect(run.executor).toHaveBeenCalledWith({ command: 'x' }, undefined);
  });

  it('pins git dates and the Python hash seed', () => {
    expect(STABLE_TOOL_ENV).toMatchObject({ PYTHONHASHSEED: '0' });
    expect(STABLE_TOOL_ENV.GIT_AUTHOR_DATE).toBe(STABLE_TOOL_ENV.GIT_COMMITTER_DATE);
  });
});
