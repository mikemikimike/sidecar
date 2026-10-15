import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { findEditMatch, findEditMatches, matchToleranceNote } from './editMatch.js';
import { editFile } from './fs.js';

// #155 ML-37: a multi-line search that differs from the file only in blank
// lines -- usually one the model left out -- failed as not-found on every
// tier. On the SWE canary that was 86 of 1,839 still-not-found multi-line
// searches (4.7%), 60 of them writable through every other guard.

const apply = (text: string, search: string, replace: string): string | null => {
  const m = findEditMatch(text, search, replace);
  return m ? text.slice(0, m.start) + m.replacement + text.slice(m.end) : null;
};

const PY = ['def f():', '    x = 1', '', '    y = 2', '    return x + y', ''].join('\n');

describe('blank-lines tier', () => {
  it('matches a search that left out a blank line, and keeps the blank line (the ML-37 case)', () => {
    const m = findEditMatch(PY, '    x = 1\n    y = 2', '    x = 10\n    y = 2');
    expect(m?.tier).toBe('blank-lines');
    expect(m?.count).toBe(1);
    expect(apply(PY, '    x = 1\n    y = 2', '    x = 10\n    y = 2')).toBe(
      ['def f():', '    x = 10', '', '    y = 2', '    return x + y', ''].join('\n'),
    );
  });

  it('keeps the gap when the edit is on either side of it', () => {
    expect(apply(PY, '    x = 1\n    y = 2\n    return x + y', '    x = 1\n    y = 3\n    return x * y')).toBe(
      ['def f():', '    x = 1', '', '    y = 3', '    return x * y', ''].join('\n'),
    );
  });

  it('keeps the gap at the edge of a changed block that grew', () => {
    expect(apply(PY, '    x = 1\n    y = 2', '    x = 10\n    w = 11\n    y = 2')).toBe(
      ['def f():', '    x = 10', '    w = 11', '', '    y = 2', '    return x + y', ''].join('\n'),
    );
  });

  it('deleting the line before the gap keeps the gap', () => {
    expect(apply(PY, '    x = 1\n    y = 2', '    y = 2')).toBe(
      ['def f():', '', '    y = 2', '    return x + y', ''].join('\n'),
    );
  });

  it('code inserted into the gap goes ahead of the kept blank line (a method added between two methods)', () => {
    const cls = [
      'class A:',
      '    def a(self):',
      '        return 1',
      '',
      '    def b(self):',
      '        return 2',
      '',
    ].join('\n');
    expect(
      apply(
        cls,
        '        return 1\n    def b(self):',
        '        return 1\n    def c(self):\n        return 3\n    def b(self):',
      ),
    ).toBe(
      [
        'class A:',
        '    def a(self):',
        '        return 1',
        '    def c(self):',
        '        return 3',
        '',
        '    def b(self):',
        '        return 2',
        '',
      ].join('\n'),
    );
  });

  it('writes the replacement as sent where it changed the number of blank lines in the gap', () => {
    // The search had one blank line here and the replacement has two: deliberate.
    const text = 'a = 1\n\n\nb = 2\n';
    expect(apply(text, 'a = 1\n\nb = 2', 'a = 1\n\n\n\nb = 2')).toBe('a = 1\n\n\n\nb = 2\n');
  });

  it('a search with a blank line the file does not have: the file keeps having none', () => {
    const text = 'a = 1\nb = 2\nc = 3\n';
    expect(apply(text, 'a = 1\n\nb = 2', 'a = 1\n\nb = 20')).toBe('a = 1\nb = 20\nc = 3\n');
  });

  it('keeps the file\'s whitespace-only "blank" line byte-for-byte, and its CRLF line endings', () => {
    const crlf = 'def f():\r\n    a = 1\r\n    \r\n    return a\r\n';
    expect(apply(crlf, '    a = 1\n    return a', '    a = 2\n    return a')).toBe(
      'def f():\r\n    a = 2\r\n    \r\n    return a\r\n',
    );
  });

  it('a search ending in a line break replaces through that break', () => {
    expect(apply(PY, '    x = 1\n    y = 2\n', '    x = 5\n    y = 2\n')).toBe(
      ['def f():', '    x = 5', '', '    y = 2', '    return x + y', ''].join('\n'),
    );
  });

  it('reports more than one occurrence as ambiguous, never picks one', () => {
    const twice = 'a()\n\nb()\nmid\na()\n\nb()\n';
    const all = findEditMatches(twice, 'a()\nb()', 'a()\nc()');
    expect(all).toHaveLength(2);
    expect(all.every((m) => m.count === 2 && m.tier === 'blank-lines')).toBe(true);
  });

  it('stays out of the way of everything it is not for', () => {
    // A single non-blank line: ignoring blank lines changes nothing.
    expect(findEditMatch('a\n\nb\n', 'a\n', 'z\n')?.tier).toBe('exact');
    expect(findEditMatch(PY, '\n    zz = 1\n', 'q')).toBeNull();
    // Starts or ends with a blank line.
    expect(findEditMatch(PY, '\n    x = 1\n    y = 2', 'q')).toBeNull();
    // A non-blank line between them in the file: that is #174's skipped-line hint, not this tier.
    expect(findEditMatch('a()\n// note\nb()\n', 'a()\nb()', 'q')).toBeNull();
    // Indentation differs as well: not only blank lines.
    expect(findEditMatch(PY, 'x = 1\ny = 2', 'q')).toBeNull();
    // Out of order.
    expect(findEditMatch(PY, '    y = 2\n    x = 1', 'q')).toBeNull();
  });

  it('an exact match still wins over a blank-tolerant one elsewhere', () => {
    const text = 'a\n\nb\n---\na\nb\n';
    const m = findEditMatch(text, 'a\nb', 'z');
    expect(m?.tier).toBe('exact');
    expect(m?.start).toBe(text.indexOf('a\nb'));
  });

  it('is disclosed to the model', () => {
    const m = findEditMatch(PY, '    x = 1\n    y = 2', '    x = 10\n    y = 2')!;
    expect(matchToleranceNote(m, 'a.py', PY)).toMatch(/blank lines did not match a\.py[\s\S]*Verify the result/);
  });
});

describe('edit_file writes through the blank-lines tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the edit, keeps the blank line, and says so', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(PY) as never);
    const write = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    const ctx = { config: { agentMode: 'agent' }, filesReadThisTurn: new Set(['a.py']) } as never;
    const result = await editFile(
      { path: 'a.py', search: '    x = 1\n    y = 2', replace: '    x = 10\n    y = 2' },
      ctx,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.from(write.mock.calls[0][1] as Uint8Array).toString()).toBe(
      ['def f():', '    x = 10', '', '    y = 2', '    return x + y', ''].join('\n'),
    );
    expect(String(result)).toContain('blank lines did not match a.py');
  });
});
