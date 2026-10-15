// How a file's bytes become the text the model reads, and back, without
// changing what the model did not touch (#165 ML-14, ML-66).
//
// read_file and edit_file decoded every file as UTF-8 and edit_file wrote it
// back as UTF-8. A Latin-1 / cp1252 file -- still common in older codebases on
// Windows -- has bytes that are not valid UTF-8, each decoded to U+FFFD and
// written back as three bytes of U+FFFD: the first successful edit corrupted
// every accented letter, curly quote and euro sign on lines the edit never
// touched. A UTF-8 byte-order mark was likewise dropped by write_file.
//
// The rule: decode a file the way its bytes say, remember how, and encode the
// result the same way. Valid UTF-8 (with or without a BOM) is UTF-8. Anything
// else is read as Windows-1252, which maps every byte to one character and
// back, so the bytes of untouched lines round-trip exactly. New text that
// cp1252 cannot hold is refused rather than written lossily.

export interface FileEncoding {
  kind: 'utf8' | 'cp1252';
  bom: boolean;
}

export const UTF8: FileEncoding = { kind: 'utf8', bom: false };

/** Windows-1252 bytes 0x80-0x9F (WHATWG); the five unassigned bytes map to the C1 control of the same value, as in the WHATWG decoder. 0x00-0x7F and 0xA0-0xFF are their own code points. */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];
const CP1252_REVERSE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Decode a file's bytes, and say how, so the same encoding can write it back. */
export function decodeFile(bytes: Uint8Array): { text: string; encoding: FileEncoding } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return { text: utf8Strict.decode(body), encoding: { kind: 'utf8', bom } };
  } catch {
    // Not UTF-8: one character per byte.
    let text = '';
    for (const b of body) text += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
    return { text, encoding: { kind: 'cp1252', bom: false } };
  }
}

/** The characters of `text` that `encoding` cannot store (empty for UTF-8). */
export function unencodableChars(text: string, encoding: FileEncoding): string[] {
  if (encoding.kind === 'utf8') return [];
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x80 && cp < 0xa0) || cp > 0xff) {
      if (!CP1252_REVERSE.has(cp)) bad.add(ch);
    }
  }
  return [...bad];
}

/** Encode `text` the way the file was. Throws when `encoding` cannot store a character -- check unencodableChars first. */
export function encodeFile(text: string, encoding: FileEncoding): Buffer {
  if (encoding.kind === 'utf8') {
    const body = Buffer.from(text, 'utf-8');
    return encoding.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const byte = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : CP1252_REVERSE.get(cp);
    if (byte === undefined)
      throw new Error(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} is not in Windows-1252`);
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/** The model-facing refusal when new text cannot be stored in the file's encoding. */
export function unencodableMessage(filePath: string, chars: string[]): string {
  const shown = chars
    .slice(0, 5)
    .map((c) => `'${c}' (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ');
  return (
    `Nothing was written to ${filePath}: the file is Windows-1252 (cp1252), not UTF-8, and your text contains ` +
    `${shown}, which that encoding cannot store. Writing it would corrupt them. Use characters the file already ` +
    `uses, or ASCII equivalents (e.g. "-" for a dash), and send the edit again.`
  );
}
