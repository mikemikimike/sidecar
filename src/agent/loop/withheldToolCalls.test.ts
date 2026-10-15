import { describe, it, expect, vi, afterEach } from 'vitest';
import { runAgentLoop } from '../loop.js';
import { withholdUnfinishedToolCalls, CUT_OFF_REASON, STREAM_ENDED_REASON } from './withheldToolCalls.js';
import { parseTextToolCalls } from './textParsing.js';
import type { ChatMessage, StreamEvent, ToolUseContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { RegisteredTool } from '../tools/shared.js';

vi.mock('../tools.js', () => ({
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

const call = (over: Partial<ToolUseContentBlock> = {}): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 'tc1',
  name: 'write_file',
  input: { path: 'a.txt', content: 'x' },
  ...over,
});

describe('withholdUnfinishedToolCalls', () => {
  it('at the output limit, withholds only calls whose arguments did not parse', () => {
    const cut = call({ id: 'cut', input: {}, _malformedInputRaw: '{"path":"README.md","content":"# Title\\nfirst' });
    const whole = call({ id: 'whole' });
    expect(withholdUnfinishedToolCalls([cut, whole], 'max_tokens')).toBe(1);
    expect(cut._withheldReason).toBe(CUT_OFF_REASON);
    expect(whole._withheldReason).toBeUndefined();
  });

  it('when the stream ended without its completion signal, withholds every call', () => {
    const a = call({ id: 'a' });
    const b = call({ id: 'b', _malformedInputRaw: '{' });
    expect(withholdUnfinishedToolCalls([a, b], 'error')).toBe(2);
    expect(a._withheldReason).toBe(STREAM_ENDED_REASON);
    expect(b._withheldReason).toBe(STREAM_ENDED_REASON);
  });

  it('leaves a finished turn alone, malformed calls included (repair is still theirs)', () => {
    for (const stop of ['tool_use', 'end_turn']) {
      const bad = call({ _malformedInputRaw: '{"path": "a.txt",}' });
      expect(withholdUnfinishedToolCalls([bad, call({ id: 'ok' })], stop)).toBe(0);
      expect(bad._withheldReason).toBeUndefined();
    }
  });

  it('a text-form call cut off mid-object is marked malformed, so the output limit withholds it', () => {
    const tools = [
      {
        name: 'write_file',
        description: 'Write a file',
        input_schema: {
          type: 'object' as const,
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    ];
    const parsed = parseTextToolCalls(
      '{"name": "write_file", "arguments": {"path": "README.md", "content": "# Title\\nfirst section',
      tools,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]._malformedInputRaw).toBeDefined();
    expect(withholdUnfinishedToolCalls(parsed, 'max_tokens')).toBe(1);
  });
});

// The regression shape agreed on #164: a harmless counter tool. One complete
// call runs once; a call cut off at the limit, or followed by the stream
// ending before its completion signal, runs zero times.
describe('runAgentLoop: tool calls from an unfinished turn never run (#164 ML-15)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function run(firstTurn: StreamEvent[]) {
    const runs: unknown[] = [];
    const counter: RegisteredTool = {
      definition: {
        name: 'counter',
        description: 'Count a call',
        input_schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      },
      executor: async (input) => {
        runs.push(input);
        return `counted ${runs.length}`;
      },
      requiresApproval: false,
    };
    const seen: ChatMessage[][] = [];
    let turn = 0;
    async function* replies(msgs: ChatMessage[]): AsyncGenerator<StreamEvent> {
      seen.push([...msgs]);
      turn++;
      if (turn === 1) {
        yield* firstTurn;
      } else {
        yield { type: 'text', text: 'Done.' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    }
    const client = {
      streamChat: (msgs: ChatMessage[]) => replies(msgs),
      getSystemPrompt: () => '',
      getRouter: () => null,
      getModel: () => 'test-model',
      completeWithOverrides: vi.fn(async () => {
        throw new Error('repair must not run for a withheld call');
      }),
    } as unknown as SideCarClient;
    vi.spyOn(await import('../../config/settings.js'), 'getConfig').mockReturnValue({
      requestTimeout: 30,
      agentMaxIterations: 25,
      agentMaxTokens: 100000,
      autoFixOnFailure: false,
      autoFixMaxRetries: 3,
      toolPermissions: {},
      hooks: {},
    } as ReturnType<typeof import('../../config/settings.js').getConfig>);
    const results: Array<{ name: string; result: string; isError: boolean }> = [];
    await runAgentLoop(
      client,
      [{ role: 'user', content: 'count' }],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: (name: string, result: string, isError: boolean) => results.push({ name, result, isError }),
        onDone: () => {},
      },
      new AbortController().signal,
      { extraTools: [counter] },
    );
    return { runs, results, seen, client };
  }

  const toolUse = (input: Record<string, unknown>, extra: Partial<ToolUseContentBlock> = {}): StreamEvent => ({
    type: 'tool_use',
    toolUse: { type: 'tool_use', id: 'c1', name: 'counter', input, ...extra },
  });

  it('a complete call runs exactly once', async () => {
    const { runs } = await run([toolUse({ label: 'one' }), { type: 'stop', stopReason: 'tool_use' }]);
    expect(runs).toEqual([{ label: 'one' }]);
  });

  it('a complete call in a turn that later hit the output limit still runs once', async () => {
    const { runs } = await run([
      toolUse({ label: 'one' }),
      { type: 'text', text: 'and now a long explanation that gets cut' },
      { type: 'stop', stopReason: 'max_tokens' },
    ]);
    expect(runs).toEqual([{ label: 'one' }]);
  });

  it('a call cut off at the output limit runs zero times, is not repaired, and the model is told why', async () => {
    // Heuristic repair WOULD close this into {"label":"abc"} and run it.
    const { runs, results, seen, client } = await run([
      toolUse({}, { _malformedInputRaw: '{"label":"abc' }),
      { type: 'stop', stopReason: 'max_tokens' },
    ]);
    expect(runs).toEqual([]);
    expect(client.completeWithOverrides).not.toHaveBeenCalled();
    expect(results).toContainEqual({ name: 'counter', result: CUT_OFF_REASON, isError: true });
    expect(JSON.stringify(seen[1])).toContain('cut off at the output-token limit');
  });

  it('a complete call followed by the stream ending without its completion signal runs zero times', async () => {
    const { runs, results } = await run([
      toolUse({ label: 'one' }),
      { type: 'warning', message: 'stream ended early' },
      { type: 'stop', stopReason: 'error' },
    ]);
    expect(runs).toEqual([]);
    expect(results).toContainEqual({ name: 'counter', result: STREAM_ENDED_REASON, isError: true });
  });

  it('a malformed call in a FINISHED turn is still repaired and runs (repair is unchanged)', async () => {
    const { runs } = await run([
      toolUse({}, { _malformedInputRaw: '{"label": "abc",}' }),
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    expect(runs).toEqual([{ label: 'abc' }]);
  });
});
