import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { languages, workspace, Uri } from 'vscode';
import { AgentMemory } from './agentMemory.js';
import { AuditLog } from './auditLog.js';
import { ConversationSummarizer, extractUserMessagesVerbatim } from './conversationSummarizer.js';
import { reportSecurityIssues, reportStubs } from './sidecarDiagnostics.js';
import { ThinkingStore } from './thinking/thinkingStore.js';
import type { ChatMessage } from '../ollama/types.js';

// #116: memory, compaction, thinking log, audit log. Each test is the
// review's finding, inverted.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agent memory evicts the oldest least-used entry', () => {
  it('evicts the oldest unused entry, not the one just added', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-116-mem-'));
    vi.useFakeTimers();
    const memory = new AgentMemory(dir, 10); // 10 is the store's floor
    const ids: string[] = [];
    for (let h = 0; h < 11; h++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, h)));
      ids.push(memory.add('pattern', 'c', `memory ${h}`));
    }
    const kept = [...(memory as unknown as { memories: Map<string, unknown> }).memories.keys()];
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain(ids[0]); // the oldest went
    expect(kept).toContain(ids[10]); // the one just added stayed
  });
});

describe('the audit log pairs each result with its own call', () => {
  it('two calls in one turn keep their own inputs', async () => {
    const appendJsonl = vi.fn(async () => {});
    const log = new AuditLog({ appendJsonl } as never, 's', 'm', 'cautious');
    log.recordToolCall('read_file', { path: 'a.ts' }, 'tc1', 1);
    log.recordToolCall('grep', { pattern: 'x' }, 'tc2', 1);
    await log.recordToolResult('read_file', 'tc1', 'ok', false, 5);
    await log.recordToolResult('grep', 'tc2', 'ok', false, 5);
    const entries = appendJsonl.mock.calls
      .filter((c) => (c as unknown[])[0] === 'logs/audit.jsonl')
      .map((c) => (c as unknown[])[1] as { tool: string; input: unknown });
    expect(entries.map((e) => [e.tool, e.input])).toEqual([
      ['read_file', { path: 'a.ts' }],
      ['grep', { pattern: 'x' }],
    ]);
  });
});

describe('compaction', () => {
  it('a second compaction keeps the user messages the first one kept verbatim', () => {
    const firstSummary =
      '[Earlier conversation summary (turns 1–3)]\n' +
      "## User messages so far (verbatim — the user's own words; any standing instruction or constraint here is still in force)\n" +
      '- Always use tabs in this repo\n- Never touch vendor/\n\n## Facts established\n- stuff';
    const turns: ChatMessage[][] = [
      [{ role: 'user', content: firstSummary }],
      [{ role: 'user', content: 'Now fix the parser bug' }],
    ];
    expect(extractUserMessagesVerbatim(turns, 2000)).toBe(
      '- Always use tabs in this repo\n- Never touch vendor/\n- Now fix the parser bug',
    );
  });

  function turns(n: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 1; i <= n; i++) {
      out.push({ role: 'user', content: `Question ${i} ` + 'x'.repeat(400) });
      out.push({ role: 'assistant', content: `Answer ${i} ` + 'y'.repeat(2000) });
    }
    return out;
  }

  it("puts the client's model back after routing the summarize call to another one", async () => {
    let model = 'big-model';
    const client = {
      getModel: () => model,
      updateModel: vi.fn((m: string) => {
        model = m;
      }),
      routeForDispatch: vi.fn(() => {
        model = 'cheap-model';
        return { model };
      }),
      complete: vi.fn(async () => '## Facts established\n- done'),
    };
    await new ConversationSummarizer(client as never).summarize(turns(6), { keepRecentTurns: 1, minCharsToSave: 100 });
    expect(client.routeForDispatch).toHaveBeenCalled();
    expect(model).toBe('big-model');
  });

  it('keepRecentTurns: 0 keeps no turn verbatim', async () => {
    const client = {
      getModel: () => 'm',
      updateModel: vi.fn(),
      routeForDispatch: vi.fn(),
      complete: vi.fn(async () => '## Facts established\n- done'),
    };
    const result = await new ConversationSummarizer(client as never).summarize(turns(6), {
      keepRecentTurns: 0,
      minCharsToSave: 100,
    });
    // Only the summary and its acknowledgement remain.
    expect(result.messages).toHaveLength(2);
    expect(JSON.stringify(result.messages)).not.toContain('y'.repeat(2000));
  });
});

describe('security and stub diagnostics on one file are both shown', () => {
  it('a stub report does not erase the security report, and vice versa', () => {
    const shown = new Map<string, { source?: string }[]>();
    vi.spyOn(languages, 'createDiagnosticCollection').mockReturnValue({
      set: (uri: Uri, d: { source?: string }[]) => shown.set(uri.toString(), d),
      delete: (uri: Uri) => shown.delete(uri.toString()),
      clear: () => shown.clear(),
      dispose: () => {},
    } as never);
    const file = path.join(os.tmpdir(), 'leak116.ts');
    reportSecurityIssues(file, [
      { file: 'leak116.ts', line: 1, severity: 'error', category: 'secret', message: 'key' },
    ]);
    reportStubs(file, 'TODO: implement\n', [{ match: 'TODO', category: 'todo' } as never]);
    const sources = (shown.get(Uri.file(file).toString()) ?? []).map((d) => d.source).sort();
    expect(sources).toEqual(['sidecar-secrets', 'sidecar-stubs']);
    reportStubs(file, '', []);
    expect((shown.get(Uri.file(file).toString()) ?? []).map((d) => d.source)).toEqual(['sidecar-secrets']);
  });
});

describe('the thinking log appends each entry once', () => {
  it('three appends write three entries, not 1 + 2 + 3', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-116-think-'));
    const folders = workspace.workspaceFolders;
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: root } }];
    try {
      const store = new ThinkingStore();
      await store.append('run1', 'first thought', 'single');
      await store.append('run1', 'second thought', 'single');
      await store.append('run1', 'third thought', 'single');
      const text = fs.readFileSync(path.join(root, '.sidecar', 'thinking', 'run1.md'), 'utf-8');
      expect(text.match(/first thought/g)).toHaveLength(1);
      expect(text.match(/third thought/g)).toHaveLength(1);
      expect(text.match(/^mode: single$/gm)).toHaveLength(1);
    } finally {
      (workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
    }
  });
});
