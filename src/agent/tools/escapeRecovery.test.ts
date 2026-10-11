import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';
import { decodeEscapesOutsideStrings, tryLiteralEscapeRecovery } from './syntaxCheck.js';
import { hasGrammars } from '../../parsing/grammarsTestSupport.js';

// #158: escape recovery decodes literal `\n` / `\t` in an edit the syntax guard
// refused, for models that serialise code as an escaped string. It decoded
// escapes that were real -- inside string literals (ML-29), after an escaped
// backslash (ML-17) -- and wrote bare LF into CRLF files (ML-17, ML-35).
// These are the investigation's repros (A2-2, A5-8, A2-12), inverted.

const BS = '\\';
const bareLf = (s: string | null) => ((s ?? '').match(/(?<!\r)\n/g) ?? []).length;

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
    editedSinceRead: new Set<string>(),
    editFailureSignatures: new Map<string, string>(),
    logDecision: () => {},
  } as never;
  try {
    return { result: await editFile(input, ctx), threw: false, written: written as string | null };
  } catch (e) {
    return { result: (e as Error).message, threw: true, written: written as string | null };
  }
}

describe('decodeEscapesOutsideStrings', () => {
  it('decodes escapes between statements, and leaves escapes inside strings alone', () => {
    expect(decodeEscapesOutsideStrings(`import os${BS}ndef f():${BS}n${BS}treturn 1`, '\n', '#')).toBe(
      'import os\ndef f():\n\treturn 1',
    );
    expect(decodeEscapesOutsideStrings(`x = "a${BS}nb"${BS}ny = 'c${BS}td'`, '\n', '#')).toBe(
      `x = "a${BS}nb"\ny = 'c${BS}td'`,
    );
  });

  it('never treats an escaped backslash as the start of an escape', () => {
    expect(decodeEscapesOutsideStrings(`sep = "${BS}${BS}n"${BS}nreturn sep`, '\n', '#')).toBe(
      `sep = "${BS}${BS}n"\nreturn sep`,
    );
  });

  it('uses the given line ending', () => {
    expect(decodeEscapesOutsideStrings(`a = 1${BS}nb = 2`, '\r\n', '#')).toBe('a = 1\r\nb = 2');
  });

  it('keeps triple-quoted, template and escaped-quote strings intact', () => {
    expect(decodeEscapesOutsideStrings(`d = """x${BS}ny"""${BS}nz = 1`, '\n', '#')).toBe(`d = """x${BS}ny"""\nz = 1`);
    expect(decodeEscapesOutsideStrings(`const t = \`a${BS}nb\`;${BS}nf();`, '\n', '//')).toBe(
      `const t = \`a${BS}nb\`;\nf();`,
    );
    expect(decodeEscapesOutsideStrings(`s = "say ${BS}"hi${BS}n${BS}""${BS}nt = 1`, '\n', '#')).toBe(
      `s = "say ${BS}"hi${BS}n${BS}""\nt = 1`,
    );
  });

  it('an apostrophe in a comment does not open a string; the escape ends the comment', () => {
    expect(decodeEscapesOutsideStrings(`# don't panic${BS}nx = 1`, '\n', '#')).toBe("# don't panic\nx = 1");
  });

  it('leaves escapes before decodeFrom as written', () => {
    expect(decodeEscapesOutsideStrings(`# split on ${BS}n${BS}nx = 1`, '\n', '#', 13)).toBe(`# split on ${BS}n\nx = 1`);
  });
});

describe.skipIf(!hasGrammars)('escape recovery through edit_file', () => {
  // ML-29 (A2-2): an indentation slip plus a legitimate in-string `\n`. The old
  // recovery decoded the string's escape, the indent error vanished from
  // tree-sitter's view, and a file CPython rejects was written as a "rescue".
  it('does not decode an escape inside a string literal; the real error is reported', async () => {
    const file = [
      'def run(args):',
      '    if args:',
      '        handle(args)',
      '    else:',
      '        print("usage")',
      '    return 0',
      '',
    ].join('\n');
    const replace = `        print("bad option")\n          print("${BS}nUsage: prog [options]")\n        print("done")`;
    const r = await run(file, { path: 'cli.py', search: '        print("usage")', replace });
    expect(r.written).toBeNull();
    expect(r.result).not.toContain('decoded file parses cleanly');
  });

  // ML-17 (A5-8): `sep = "\\n"` with escaped line breaks. The old decode turned
  // the escaped backslash + n into `"\<newline>"`, an empty string.
  it('keeps an escaped backslash before n', async () => {
    const file = 'def join_lines(xs):\n    return xs\n';
    const replace = `    sep = "${BS}${BS}n"${BS}n    return sep.join(xs)`;
    const r = await run(file, { path: 'u.py', search: '    return xs', replace });
    expect(r.written).toBe(`def join_lines(xs):\n    sep = "${BS}${BS}n"\n    return sep.join(xs)\n`);
  });

  it('keeps a Windows path literal intact', async () => {
    const file = 'def where():\n    return None\n';
    const replace = `    base = "C:${BS}${BS}temp"${BS}n    return base`;
    const r = await run(file, { path: 'w.py', search: '    return None', replace });
    expect(r.written).toBe(`def where():\n    base = "C:${BS}${BS}temp"\n    return base\n`);
  });

  // ML-35 / ML-17 (A2-12, A5-8): decoded line breaks were bare LF in CRLF files.
  it('decodes to CRLF in a CRLF file', async () => {
    const file = 'def add(a, b):\r\n    return a + b\r\n';
    const r = await run(file, {
      path: 'calc.py',
      search: '    return a + b',
      replace: `    return a + b${BS}n${BS}n${BS}ndef multiply(a, b):${BS}n    return a * b`,
    });
    expect(r.threw).toBe(false);
    expect(r.written).toBe('def add(a, b):\r\n    return a + b\r\n\r\n\r\ndef multiply(a, b):\r\n    return a * b\r\n');
    expect(bareLf(r.written)).toBe(0);
  });

  it('still rescues the case it exists for: code serialised as one escaped string', async () => {
    const recovered = await tryLiteralEscapeRecovery(
      'calculator.py',
      '',
      `import math${BS}n${BS}ndef add(a, b):${BS}n    return a + b${BS}n`,
    );
    expect(recovered).toBe('import math\n\ndef add(a, b):\n    return a + b\n');
  });
});
