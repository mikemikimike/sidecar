import { describe, it, expect, vi } from 'vitest';
import { fenceAlreadyInFile, applyFenceWrite } from './fenceWrite.js';
import { isChangeNotation, newSideOf, synthesizeFenceWrite } from './textParsing.js';
import { stubLoopState } from './testHelpers.js';
import type { AgentCallbacks } from '../loop.js';
import type { TurnResult } from './streamTurn.js';

// 2026-10-15 release eval, gemma4:31b: a correct edit, then a closing summary
// whose code block showed the edited lines. With no test to verify the edit,
// the block was written to disk as a fence write -- refused, but the refusal
// sent a finished model back to work. 6 of 6 trials of two large-file cases
// failed this way after a correct first edit.

const FILE = [
  'class FieldValidator7:',
  '    def is_within_bounds(self, value):',
  '        """Bounds check for field7."""',
  '        if value is None:',
  '            return False',
  '        if value < 0:',
  '            return False',
  '        if value > self.maximum:',
  '            return False',
  '        return True',
  '',
].join('\r\n');

// The exact block gemma4:31b printed after its edit had landed.
const SUMMARY_BLOCK =
  '        if value is None:\n            return False\n        if value < 0:\n            return False\n        if value > self.maximum:\n';

describe('fenceAlreadyInFile', () => {
  it('a block whose lines are already in the file, in order, is a quote of it', () => {
    expect(fenceAlreadyInFile(SUMMARY_BLOCK, FILE)).toBe(true);
    expect(fenceAlreadyInFile('\n' + SUMMARY_BLOCK + '\n\n', FILE)).toBe(true);
  });

  it('a block with a line the file lacks, or out of order, is not', () => {
    expect(fenceAlreadyInFile(SUMMARY_BLOCK.replace('value < 0', 'value < -1'), FILE)).toBe(false);
    expect(fenceAlreadyInFile('        return True\n        if value is None:\n', FILE)).toBe(false);
    expect(fenceAlreadyInFile('\n\n', FILE)).toBe(false);
  });
});

describe('applyFenceWrite', () => {
  const run = async (read: (p: string) => Promise<string | null>) => {
    const state = stubLoopState();
    const onText = vi.fn();
    const onToolCall = vi.fn();
    const callbacks = { onText, onToolCall, onToolResult: vi.fn(), onDone: vi.fn() } as unknown as AgentCallbacks;
    const resolved: TurnResult = {
      fullText: 'I have updated it.',
      pendingToolUses: [],
      stopReason: 'end_turn',
      terminated: 'none',
      fenceWrite: { path: 'src/validators.py', content: SUMMARY_BLOCK },
    };
    await applyFenceWrite(resolved, state, callbacks, read);
    return { resolved, onText, onToolCall, state };
  };

  it('does not write a block that is already in the file: the turn ends as a completion', async () => {
    const { resolved, onText, onToolCall, state } = await run(async () => FILE);
    expect(resolved.pendingToolUses).toEqual([]);
    expect(resolved.stopReason).toBe('end_turn');
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(state.fenceWriteCoercions).toBe(0);
    // ...and the action reprompt is told, so it does not say the code was not saved.
    expect(state.printedCodeAlreadyInFile).toBe(true);
  });

  it('writes a block that is new (or a file that does not exist yet), as before', async () => {
    for (const read of [async () => FILE.replace('if value < 0:', 'if value < -5:'), async () => null]) {
      const { resolved, onToolCall, state } = await run(read);
      expect(resolved.pendingToolUses).toHaveLength(1);
      expect(resolved.pendingToolUses[0]).toMatchObject({ id: 'fence_write_1', name: 'write_file' });
      expect(resolved.stopReason).toBe('tool_use');
      expect(onToolCall).toHaveBeenCalledOnce();
      expect(state.fenceWriteCoercions).toBe(1);
    }
  });
});

// gemma4:31b's other summary shape: the change in merge-conflict notation.
const CONFLICT_SUMMARY = '<<<<\n        if value > self.maximum:\n====\n        if value >= self.maximum:\n>>>>\n';

describe('change notation is never written, and is checked by its new side', () => {
  it('isChangeNotation / newSideOf: conflict markers, a unified diff, a +/- block', () => {
    expect(isChangeNotation(CONFLICT_SUMMARY)).toBe(true);
    expect(newSideOf(CONFLICT_SUMMARY)).toBe('        if value >= self.maximum:\n');
    const diff = '@@ -1,2 +1,2 @@\n def f(x):\n-    return x > 1\n+    return x >= 1\n';
    expect(newSideOf(diff)).toBe('def f(x):\n    return x >= 1\n');
    expect(newSideOf('-    a = 1\n+    a = 2\n     b = 3\n')).toBe('    a = 2\n    b = 3\n');
    expect(isChangeNotation('def f(x):\n    return x - 1\n')).toBe(false);
  });

  it('synthesizes no write from a conflict-notation block', () => {
    const text = 'I changed it:\n```python\n' + CONFLICT_SUMMARY + '```\n';
    expect(synthesizeFenceWrite(text, 'Fix src/validators.py', new Set(['write_file']))).toBeNull();
  });

  it('a conflict-notation summary whose new side is in the file is finished work: flag set, nothing dispatched', async () => {
    const fixed = FILE.replace('if value > self.maximum:', 'if value >= self.maximum:');
    const state = stubLoopState();
    const onToolCall = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onToolCall,
      onToolResult: vi.fn(),
      onDone: vi.fn(),
    } as unknown as AgentCallbacks;
    const resolved: TurnResult = {
      fullText: 'done',
      pendingToolUses: [],
      stopReason: 'end_turn',
      terminated: 'none',
      printedCode: { path: 'src/validators.py', code: newSideOf(CONFLICT_SUMMARY) },
    };
    await applyFenceWrite(resolved, state, callbacks, async () => fixed);
    expect(state.printedCodeAlreadyInFile).toBe(true);
    expect(resolved.pendingToolUses).toEqual([]);
    expect(onToolCall).not.toHaveBeenCalled();
  });
});
