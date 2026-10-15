import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { decodeFile, encodeFile, unencodableChars } from './fileEncoding.js';
import { editFile, writeFile, readFile } from './fs.js';

// #165 ML-14 / ML-66: files are written back in their own encoding, BOM and line endings.

// "café – naïve “quoted” €5\r\n" in Windows-1252, and a second line the edits never touch.
const CP1252 = Buffer.from([
  0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65,
  0x64, 0x94, 0x20, 0x80, 0x35, 0x0d, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x0d, 0x0a,
]);

describe('decodeFile / encodeFile', () => {
  it('reads a cp1252 file as the characters it means, and writes back the identical bytes', () => {
    const { text, encoding } = decodeFile(CP1252);
    expect(encoding).toEqual({ kind: 'cp1252', bom: false });
    expect(text).toBe('café – naïve “quoted” €5\r\nx = 1\r\n');
    expect(encodeFile(text, encoding).equals(CP1252)).toBe(true);
  });

  it('round-trips every byte value of a non-UTF-8 file', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { text, encoding } = decodeFile(all);
    expect(encoding.kind).toBe('cp1252');
    expect(encodeFile(text, encoding).equals(all)).toBe(true);
  });

  it('keeps a UTF-8 BOM out of the text and puts it back on write', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('é = 1\n', 'utf-8')]);
    const { text, encoding } = decodeFile(bom);
    expect(text).toBe('é = 1\n');
    expect(encoding).toEqual({ kind: 'utf8', bom: true });
    expect(encodeFile(text, encoding).equals(bom)).toBe(true);
  });

  it('names what cp1252 cannot store, and nothing UTF-8 cannot', () => {
    const cp = { kind: 'cp1252', bom: false } as const;
    expect(unencodableChars('café “x” € —', cp)).toEqual([]);
    expect(unencodableChars('→ 你好 é', cp)).toEqual(['→', '你', '好']);
    expect(unencodableChars('→ 你好', { kind: 'utf8', bom: false })).toEqual([]);
  });
});

describe('the file tools keep the file as it was', () => {
  afterEach(() => vi.restoreAllMocks());
  function mount(bytes: Buffer) {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(bytes as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
  }
  const ctx = (p: string) => ({ config: { agentMode: 'agent' }, filesReadThisTurn: new Set([p]) }) as never;
  const writtenBytes = (w: ReturnType<typeof mount>) => Buffer.from(w.mock.calls[0][1] as Uint8Array);

  it('edit_file on a cp1252 file leaves the untouched line byte-identical (the ML-14 case)', async () => {
    const write = mount(CP1252);
    await editFile({ path: 'legacy.txt', search: 'x = 1', replace: 'x = 2' }, ctx('legacy.txt'));
    const expected = Buffer.from(CP1252);
    expected[expected.length - 3] = 0x32; // only the '1' became '2'
    expect(writtenBytes(write).equals(expected)).toBe(true);
  });

  it('read_file shows a cp1252 file as text an edit search can match', async () => {
    mount(CP1252);
    const shown = String(await readFile({ path: 'legacy.txt' }, ctx('legacy.txt')));
    expect(shown).toContain('café – naïve “quoted” €5');
  });

  it('edit_file refuses text a cp1252 file cannot store, and writes nothing', async () => {
    const write = mount(CP1252);
    await expect(
      editFile({ path: 'legacy.txt', search: 'x = 1', replace: 'x = 1 → 2' }, ctx('legacy.txt')),
    ).rejects.toThrow(/Windows-1252[\s\S]*'→' \(U\+2192\)/);
    expect(write).not.toHaveBeenCalled();
  });

  it('write_file over a CRLF file writes CRLF, and keeps a BOM (the ML-66 case)', async () => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('a = 1\r\nb = 2\r\n', 'utf-8')]);
    const write = mount(original);
    await writeFile({ path: 'm.py', content: 'a = 1\nb = 3\n' }, ctx('m.py'));
    expect(writtenBytes(write).equals(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('a = 1\r\nb = 3\r\n')]))).toBe(
      true,
    );
  });

  it('write_file over an LF file, or creating a file, writes what was sent', async () => {
    const write = mount(Buffer.from('a = 1\nb = 2\n'));
    await writeFile({ path: 'n.py', content: 'a = 1\nb = 3\n' }, ctx('n.py'));
    expect(writtenBytes(write).toString()).toBe('a = 1\nb = 3\n');
  });
});
