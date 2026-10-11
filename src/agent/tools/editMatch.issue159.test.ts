import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';
import { findEditMatch, findEditMatches } from './editMatch.js';

// #159: the tolerant tiers of edit_file's matcher wrote wrong bytes. Each test
// is the investigation's repro (A1-1..A1-8, DS-5, A3-7) with its expectation
// inverted: what the edit should have written.

afterEach(() => vi.restoreAllMocks());

async function run(file: string, input: Record<string, unknown>) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(file, 'utf-8') as never);
  let written: string | null = null;
  vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
    written = Buffer.from(c as Uint8Array).toString('utf-8');
  });
  const ctx = {
    config: { agentMode: 'agent', editResultDiffChars: 800, codeAsTextRecoveryEnabled: true },
    filesReadThisTurn: new Set([String(input.path)]),
  } as never;
  try {
    return { result: await editFile(input, ctx), written: written as string | null };
  } catch (e) {
    return { result: (e as Error).message, written: written as string | null };
  }
}

const apply = (text: string, search: string, replace: string) => {
  const m = findEditMatch(text, search, replace);
  return m ? text.slice(0, m.start) + m.replacement + text.slice(m.end) : null;
};

describe('ML-03: the indent tier keeps each line at its own level', () => {
  const label =
    'def label(obj, path=None):\n    if path:\n        name = path\n    else:\n        name = obj.__name__\n    return name.upper()\n';
  const input = {
    path: 'label.py',
    search: '    else:\n        name = obj.__name__\n        return name.upper()',
    replace: '    else:\n        name = obj.__qualname__\n        return name.upper()',
  };

  it('does not match a search whose nesting contradicts the file (return placed inside else)', async () => {
    expect(findEditMatch(label, input.search, input.replace)).toBeNull();
    const { written } = await run(label, input);
    expect(written ?? '').not.toContain('        return name.upper()');
  });

  it('the same on a CRLF file', async () => {
    const { written } = await run(label.replace(/\n/g, '\r\n'), input);
    expect(written ?? '').not.toContain('        return name.upper()');
  });

  it('keeps a newline-led edit inside its loop', async () => {
    const file = 'def f(items):\n    for i in items:\n        process(i)\n        log(i)\n    return 0\n';
    const { written } = await run(file, { path: 'proc.py', search: '\n    log(i)', replace: '\n    log(i, level=2)' });
    expect(written).toBe(
      'def f(items):\n    for i in items:\n        process(i)\n        log(i, level=2)\n    return 0\n',
    );
  });

  it('writes a token-start body at the file body level', async () => {
    const file = 'class C:\n    def f(self):\n        x = 1\n        return x\n';
    const { written } = await run(file, {
      path: 'c.py',
      search: 'def f(self):\n      x = 1\n      return x',
      replace: 'def f(self):\n      x = 2\n      return x',
    });
    expect(written).toBe('class C:\n    def f(self):\n        x = 2\n        return x\n');
  });
});

describe('ML-22: a uniform over- or under-indent shifts every line', () => {
  it('over-indented by 4: return stays after the loop', async () => {
    const file = 'def total(xs):\n    acc = 0\n    for x in xs:\n        acc += x\n    return acc\n';
    const { written } = await run(file, {
      path: 'calc.py',
      search: '            acc += x\n        return acc',
      replace: '            acc += x * 2\n        return acc',
    });
    expect(written).toBe('def total(xs):\n    acc = 0\n    for x in xs:\n        acc += x * 2\n    return acc\n');
  });

  it('under-indented by 4: def clear stays in the class', async () => {
    const file =
      'class Cart:\n    def total(self):\n        s = sum(self.items)\n        return s\n\n    def clear(self):\n        self.items = []\n';
    const { written } = await run(file, {
      path: 'cart.py',
      search: '    return s\n\ndef clear(self):',
      replace: '    return round(s, 2)\n\ndef clear(self):',
    });
    expect(written).toBe(
      'class Cart:\n    def total(self):\n        s = sum(self.items)\n        return round(s, 2)\n\n    def clear(self):\n        self.items = []\n',
    );
  });

  it('a replacement line shallower than every search line is placed one level up', () => {
    expect(apply('x0q\n    x1q', '            x1q', '        new0()_v2\n            x1q')).toBe(
      'x0q\nnew0()_v2\n    x1q',
    );
  });
});

describe('ML-23: a mid-line within locator', () => {
  const PY = 'class A:\n    def foo(self):\n        return 1\n\n    def bar(self):\n        return 2\n';
  const TS = 'class A {\n    foo() {\n        return 1;\n    }\n}\n';

  it('Python: applies as it does without the locator', async () => {
    const base = {
      path: 'a.py',
      search: '    def foo(self):\n        return 1',
      replace: '    def foo(self):\n        return 10',
    };
    const { written } = await run(PY, { ...base, within: 'def foo(self):' });
    expect(written).toBe(PY.replace('return 1\n', 'return 10\n'));
  });

  it('TypeScript: keeps the body indentation', async () => {
    const base = { path: 'a.ts', search: '    foo() {\n        return 1;', replace: '    foo() {\n        return 10;' };
    const { written } = await run(TS, { ...base, within: 'foo() {' });
    expect(written).toBe('class A {\n    foo() {\n        return 10;\n    }\n}\n');
  });
});

describe('ML-68: the indent tier never matches mid-line', () => {
  it('does not splice an indented search after `self.`', async () => {
    const src =
      'class NCA:\n    def __init__(self, n_components=None):\n        self.n_components = n_components\n        self.init = 1\n';
    expect(
      findEditMatch(src, '            n_components = n_components', '            n_components = int(n_components)'),
    ).toBeNull();
  });

  it('does not splice into a comment that quotes the line', () => {
    const src =
      'def onchanged(values):\n    print(values)\n    # FIX: Instead of plt.clf(), which clears the full state,\n    plt.draw()\n';
    expect(apply(src, '    plt.clf()', '    # FIX: No clearing needed.') ?? '').not.toContain('Instead of     # FIX');
  });
});

describe('ML-41: an exact match whose Python replacement starts at column 0', () => {
  it('keeps the replacement inside its block, and says so', async () => {
    const file =
      'def load(path):\n    data = read(path)\n    if not data:\n        data = {}\n    cache[path] = data\n';
    const { result, written } = await run(file, {
      path: 'm.py',
      search: '    if not data:\n        data = {}',
      replace: 'if not data:\n    data = default()',
    });
    expect(written).toBe(
      'def load(path):\n    data = read(path)\n    if not data:\n        data = default()\n    cache[path] = data\n',
    );
    expect(result).toMatch(/started at column 0/);
  });

  it('does not write a module-level return', async () => {
    const file =
      'def to_rational(expr):\n    rv = expr.simplify()\n    if rv != expr:\n        return rv\n    return convert(expr)\n\n\nX = 1\n';
    const { written } = await run(file, {
      path: 'm.py',
      search: '    if rv != expr:\n        return rv\n    return convert(expr)',
      replace: 'return rv',
    });
    expect(written).toBe('def to_rational(expr):\n    rv = expr.simplify()\n    return rv\n\n\nX = 1\n');
  });

  it('only for Python: elsewhere column 0 can be the intent', () => {
    expect(apply('items:\n  - a\n', '  - a', '- a')).toBe('items:\n- a\n');
  });
});

describe('ML-25, ML-26, ML-27: span edges', () => {
  it('ML-25: a search ending with the next line indentation does not double it', () => {
    const out = apply('v0 = f(0)\n    v1 = f(1)\n    v2 = f(2)\n', 'v0 = f(0) \n    ', 'v0 = f(0, 0) \n    ');
    expect(out).toContain('\n    v1 = f(1)');
    expect(out).not.toContain('\n        v1 = f(1)');
  });

  it('ML-26: a newline-terminated search leaves the next whitespace-only line alone', async () => {
    const file = ['x1q()', 'x2q()  ', '        ', 'x4q()', ''].join('\n');
    const { written } = await run(file, { path: 'w.py', search: 'x2q()\n', replace: 'x2q(1)\n' });
    expect(written).toBe(['x1q()', 'x2q(1)', '        ', 'x4q()', ''].join('\n'));
  });

  it('ML-26 on the indent tier', async () => {
    const file = ['def f():', '    a = 1', '    b = 2', '    ', '    c = 3', ''].join('\n');
    const { written } = await run(file, { path: 'i.py', search: 'a = 1\nb = 2\n', replace: 'a = 1\nb = 4\n' });
    expect(written).toBe(['def f():', '    a = 1', '    b = 4', '    ', '    c = 3', ''].join('\n'));
  });

  it('ML-27: a match ending between CR and LF keeps the line break whole', async () => {
    const file = 'x0q\r\n    x1q\r\nx2q\r\n';
    expect((await run(file, { path: 'r.py', search: '    x1q\r', replace: '    x1q_v2\r' })).written).toBe(
      'x0q\r\n    x1q_v2\r\nx2q\r\n',
    );
    expect((await run(file, { path: 'r.py', search: '    x1q\r', replace: '    x1q_v2' })).written).toBe(
      'x0q\r\n    x1q_v2\r\nx2q\r\n',
    );
  });
});

describe('ML-28: overlapping occurrences are ambiguous', () => {
  const file = 'head()\nx = 1\nmid()\nx = 1\nmid()\nx = 1\ntail()\n';
  const search = 'x = 1\nmid()\nx = 1';
  const replace = 'x = 2\nmid()\nx = 2';

  it('counts both', () => {
    expect(findEditMatches(file, search, replace)[0].count).toBe(2);
    expect(findEditMatches(file, search.replace(/\n/g, '\r\n'), replace.replace(/\n/g, '\r\n'))[0].count).toBe(2);
  });

  it('refuses a single edit', async () => {
    const { result, written } = await run(file, { path: 'o.py', search, replace });
    expect(written).toBeNull();
    expect(result).toMatch(/appears 2 times/);
  });

  it('refuses replace_all rather than change one region and report both', async () => {
    const { result, written } = await run(file, { path: 'o.py', search, replace, replace_all: true });
    expect(written).toBeNull();
    expect(result).toMatch(/overlap/);
  });
});
