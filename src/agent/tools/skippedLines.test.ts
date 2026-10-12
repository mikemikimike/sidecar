import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { findSkippedLinesMatch, skippedLinesError } from './skippedLines.js';
import { editFile } from './fs.js';

// A search whose lines are all in the file, in order, but which left out a line
// between two of them. Replayed over a week of recorded eval runs, this shape
// was 41 of 274 "not found" failures with known content; in every one the
// model later fixed, its eventual edit was in exactly the region named here.

const FILE = [
  '// Import the format module',
  "const format = require('./format');",
  '// Use the truncate function from it',
  'const truncate = format.truncate;',
  '',
  "console.log(truncate('hello', 3));",
  '',
].join('\n');

describe('findSkippedLinesMatch', () => {
  it('names the region and the comment the search left out (the eval-log case)', () => {
    const m = findSkippedLinesMatch(FILE, "const format = require('./format');\nconst truncate = format.truncate;");
    expect(m).toEqual({
      region:
        "const format = require('./format');\n// Use the truncate function from it\nconst truncate = format.truncate;",
      skipped: [{ line: 3, text: '// Use the truncate function from it' }],
    });
  });

  it('catches a dropped blank line, and keeps CRLF in the region', () => {
    const crlf = 'def f():\r\n    a = 1\r\n\r\n    return a\r\n';
    const m = findSkippedLinesMatch(crlf, '    a = 1\n    return a');
    expect(m?.region).toBe('    a = 1\r\n\r\n    return a');
    expect(m?.skipped).toEqual([{ line: 3, text: '' }]);
  });

  it('stays silent when the location is not certain', () => {
    const twice = 'a()\n// x\nb()\n\na()\n// y\nb()\n';
    expect(findSkippedLinesMatch(twice, 'a()\nb()')).toBeNull();
  });

  it('stays silent when nothing was skipped, lines are out of order, or the gap is wide', () => {
    expect(findSkippedLinesMatch('a()\nb()\n', 'a()\nb()')).toBeNull();
    expect(findSkippedLinesMatch('a()\nb()\n', 'b()\na()')).toBeNull();
    expect(findSkippedLinesMatch('a()\n1\n2\n3\n4\nb()\n', 'a()\nb()')).toBeNull();
    expect(findSkippedLinesMatch('a()\nb()\n', 'a()')).toBeNull();
  });

  it('the message shows the block and warns that skipped lines left out of replace are deleted', () => {
    const msg = skippedLinesError(
      't.js',
      findSkippedLinesMatch(FILE, "const format = require('./format');\nconst truncate = format.truncate;")!,
    );
    expect(msg).toContain('line 3: // Use the truncate function from it');
    expect(msg).toContain(
      "```\nconst format = require('./format');\n// Use the truncate function from it\nconst truncate = format.truncate;\n```",
    );
    expect(msg).toMatch(/keep the skipped line unless you mean to delete it/);
  });
});

describe('edit_file reports a skipped line', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses with the exact region instead of a guess, and writes nothing', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(FILE) as never);
    const write = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    const ctx = { config: { agentMode: 'agent' }, filesReadThisTurn: new Set(['t.js']) } as never;
    await expect(
      editFile(
        {
          path: 't.js',
          search: "const format = require('./format');\nconst truncate = format.truncate;",
          replace: "const format = require('./format');\nconst truncate = format.truncateWords;",
        },
        ctx,
      ),
    ).rejects.toThrow(/not in t\.js as one block[\s\S]*line 3: \/\/ Use the truncate function from it/);
    expect(write).not.toHaveBeenCalled();
  });
});
