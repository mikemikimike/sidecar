// Whitespace- and line-ending-tolerant matching for edit_file.
//
// edit_file's contract is byte-exact: `search` must appear in the file
// verbatim. That is the right default — it is what makes the uniqueness and
// token-boundary guards meaningful — but taken alone it fails an entire class
// of edits for reasons that have nothing to do with the model being wrong:
//
//   • CRLF. A model emits LF. On a CRLF file every MULTI-LINE search misses,
//     because the file holds `a\r\nb` and the search holds `a\nb`. The error
//     said "search string not found", which is true and useless — the text IS
//     there. Single-line searches worked, so the failure looked random.
//   • Trailing whitespace. `read_file(mode='compact')` right-trims every line,
//     so text copied out of a compact read cannot match the file it came from.
//   • Indentation. A model retyping a block from memory reproduces the code and
//     loses the leading indentation, or produces 2-space where the file has 4.
//
// Each tier below resolves to a REAL byte span in the original text, so the
// caller splices with `text.slice()` and every downstream guard still runs
// against real file bytes. Tolerance only ever converts a hard failure into a
// disclosed success — an exact match is always preferred, and a tier that finds
// more than one match reports the ambiguity rather than picking one.

/** How much whitespace difference a match had to absorb. `exact` = none. */
export type MatchTier = 'exact' | 'eol' | 'trailing-space' | 'indent';

export interface EditMatch {
  /** Byte offset of the match in the ORIGINAL text. */
  start: number;
  /** Exclusive end offset in the ORIGINAL text. */
  end: number;
  /** Occurrences at the winning tier. > 1 means the caller must refuse as ambiguous. */
  count: number;
  tier: MatchTier;
  /**
   * `replace`, adapted to the file: line endings converted to the file's
   * dominant convention, and (on the `indent` tier) re-indented to the matched
   * region's indentation.
   */
  replacement: string;
  /**
   * Set on an exact match whose replacement started at column 0 while the
   * code it replaces is indented: the replacement was re-based onto the
   * search's indentation (ML-41). Disclosed like a tolerance.
   */
  rebasedFromColumnZero?: boolean;
}

export interface EolInfo {
  /** The file's dominant line ending. `\n` when the text has no line breaks. */
  eol: '\n' | '\r\n' | '\r';
  /** False when the text mixes conventions — then `eol` is merely the most common. */
  uniform: boolean;
}

export function detectEol(text: string): EolInfo {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const kinds = [crlf, cr, lf].filter((n) => n > 0).length;
  if (crlf === 0 && cr === 0) return { eol: '\n', uniform: kinds <= 1 };
  if (crlf >= cr && crlf >= lf) return { eol: '\r\n', uniform: kinds <= 1 };
  if (cr >= lf) return { eol: '\r', uniform: kinds <= 1 };
  return { eol: '\n', uniform: kinds <= 1 };
}

/** Rewrite every line ending in `text` to `eol`, whatever it currently uses. */
export function applyEol(text: string, eol: string): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

/**
 * A canonical form of `text` for one tolerance tier, plus a map from each
 * canonical character back to its offset in the original. The map is what lets
 * a tolerant match still name an exact byte span: characters the tier ignores
 * (a `\r`, a run of trailing spaces, a line's indentation) are dropped from the
 * canonical string and simply have no entry.
 */
function canonicalize(text: string, tier: MatchTier): { canon: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let atLineStart = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\r') {
      // CRLF: drop the \r and let the \n be emitted next pass. Lone CR (classic
      // Mac): emit as \n so it compares equal to an LF search.
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      out.push('\n');
      map.push(i);
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      out.push('\n');
      map.push(i);
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (tier === 'indent' && atLineStart) {
        i++;
        continue;
      }
      if (tier !== 'eol') {
        // Trailing run: whitespace with nothing but a line break (or EOF) after it.
        let j = i;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
        const next = text[j];
        if (next === undefined || next === '\n' || next === '\r') {
          i = j;
          continue;
        }
      }
    }
    out.push(ch);
    map.push(i);
    atLineStart = false;
    i++;
  }
  return { canon: out.join(''), map };
}

const leadingWhitespace = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Columns an indentation string occupies, a tab counting as 4. Used only to order and scale levels. */
const indentWidth = (s: string): number => [...s].reduce((w, c) => w + (c === '\t' ? 4 : 1), 0);

/**
 * The search's indentation levels mapped onto the file's, from the lines the
 * match aligned. Null when the two disagree about nesting -- the same search
 * level at two file levels, two search levels at one, or a reversed order --
 * which means the search describes different structure than the file has,
 * and the match must not be used (ML-03: the indent tier ignored indentation
 * entirely and re-based by the first line's delta, so a `return` the search
 * placed inside an `else` was written there).
 */
function alignIndentLevels(searchLines: string[], fileLines: string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (let k = 0; k < searchLines.length && k < fileLines.length; k++) {
    if (searchLines[k].trim() === '' || fileLines[k].trim() === '') continue;
    const s = leadingWhitespace(searchLines[k]);
    const f = leadingWhitespace(fileLines[k]);
    if ((map.has(s) && map.get(s) !== f) || (reverse.has(f) && reverse.get(f) !== s)) return null;
    map.set(s, f);
    reverse.set(f, s);
  }
  const pairs = [...map].sort((a, b) => indentWidth(a[0]) - indentWidth(b[0]));
  for (let i = 1; i < pairs.length; i++) {
    if (indentWidth(pairs[i][1]) <= indentWidth(pairs[i - 1][1])) return null;
  }
  return map;
}

/** The file's indentation unit: a tab, or the most common positive step between consecutive lines. */
function fileIndentUnit(text: string, eol: string): string {
  const lines = text.split(eol).filter((l) => l.trim() !== '');
  if (lines.some((l) => l.startsWith('\t'))) return '\t';
  const steps = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const d = leadingWhitespace(lines[i]).length - leadingWhitespace(lines[i - 1]).length;
    if (d > 0) steps.set(d, (steps.get(d) ?? 0) + 1);
  }
  const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return ' '.repeat(best?.[0] ?? 4);
}

/**
 * Re-indent `replacement` line by line through the aligned levels: a line at a
 * search level gets that level's file indentation; a level the search did not
 * use is placed by counting indentation units from the nearest aligned level.
 * Relative nesting survives a 2-space search on a 4-space file, a tab search on
 * a space file, and a search whose first line is not its shallowest (ML-22).
 * Blank lines are left alone so re-indenting never adds trailing whitespace.
 */
function reindentByLevels(
  replacement: string,
  levels: Map<string, string>,
  searchLines: string[],
  text: string,
  eol: string,
): string {
  if ([...levels].every(([s, f]) => s === f)) return replacement;
  const known = [...levels].sort((a, b) => indentWidth(a[0]) - indentWidth(b[0]));
  if (known.length === 0) return replacement;
  const fileUnit = fileIndentUnit(text, eol);
  const widths = [
    ...new Set(
      [...searchLines, ...replacement.split(eol)]
        .filter((l) => l.trim() !== '')
        .map((l) => indentWidth(leadingWhitespace(l))),
    ),
  ].sort((a, b) => a - b);
  let searchUnit = 0;
  for (let i = 1; i < widths.length; i++) {
    const d = widths[i] - widths[i - 1];
    if (d > 0 && (searchUnit === 0 || d < searchUnit)) searchUnit = d;
  }
  if (searchUnit === 0) searchUnit = indentWidth(fileUnit);
  return replacement
    .split(eol)
    .map((line) => {
      if (line.trim() === '') return line;
      const own = leadingWhitespace(line);
      const body = line.slice(own.length);
      const exact = levels.get(own);
      if (exact !== undefined) return exact + body;
      const w = indentWidth(own);
      const below = [...known].reverse().find(([s]) => indentWidth(s) <= w);
      if (below) {
        const units = Math.round((w - indentWidth(below[0])) / searchUnit);
        return below[1] + fileUnit.repeat(Math.max(0, units)) + body;
      }
      const [lowS, lowF] = known[0];
      let indent = lowF;
      for (let u = Math.round((indentWidth(lowS) - w) / searchUnit); u > 0; u--) {
        indent = indent.endsWith(fileUnit) ? indent.slice(0, -fileUnit.length) : '';
      }
      return indent + body;
    })
    .join(eol);
}

/** Prefix every non-blank line with `indent`. */
const indentAll = (s: string, indent: string, eol: string): string =>
  s
    .split(eol)
    .map((l) => (l.trim() === '' ? l : indent + l))
    .join(eol);

/**
 * Locate `search` in `text`, absorbing as little whitespace difference as
 * possible, and return the byte span it occupies together with `replace`
 * adapted to the file. Returns null when no tier matches — the caller then
 * falls through to the intent-based fuzzy recovery.
 */
export function findEditMatch(
  text: string,
  search: string,
  replace: string,
  options: MatchOptions = {},
): EditMatch | null {
  return findEditMatches(text, search, replace, options)[0] ?? null;
}

/**
 * Every non-overlapping occurrence of `search` at the first tier that matches,
 * in file order, each with its own span and its own adapted replacement (on
 * the `indent` tier every occurrence is re-indented to ITS indentation).
 * `count` on each is the total. Empty when no tier matches.
 *
 * replace_all needs all of them: splitting on the first match's exact bytes
 * left any occurrence the tier had matched with different whitespace
 * untouched, while the summary still counted it as replaced.
 */
export interface MatchOptions {
  /**
   * Re-base an exact match's column-0 replacement onto the search's
   * indentation (ML-41). Only where indentation is syntax -- Python -- is a
   * column-0 replacement of indented code almost always a mistake; in YAML,
   * Markdown or text it is often the intent.
   */
  rebaseColumnZero?: boolean;
}

export function findEditMatches(
  text: string,
  search: string,
  replace: string,
  options: MatchOptions = {},
): EditMatch[] {
  if (search === '') return [];
  const { eol } = detectEol(text);
  const adapted = applyEol(replace, eol);

  /**
   * Absorb the `\r` the span begins just after. A search starting with `\n`
   * matches the second half of a `\r\n` pair, so the span opens between the
   * two; replacing from there left the file's `\r` stranded (as `\r\r\n` in
   * front of a replacement that starts with a line break, or as a lone `\r`
   * in front of one that does not). The `\r` belongs to the line break the
   * search is replacing, so it goes with it.
   */
  const absorbSplitCrlf = (start: number): number =>
    start > 0 && text[start] === '\n' && text[start - 1] === '\r' ? start - 1 : start;

  /**
   * The same at the end (ML-27): a span ending between `\r` and `\n` -- a
   * search ending in a lone `\r` -- left the `\n` behind as a bare LF. The
   * file's line break stays whole: the `\r` leaves the span, and the line
   * break the replacement gained from its own trailing `\r` is dropped.
   */
  const splitCrlfAtEnd = (end: number): boolean => end > 0 && text[end - 1] === '\r' && text[end] === '\n';
  const withoutTrailingBreak = (r: string): string => (r.endsWith(eol) ? r.slice(0, -eol.length) : r);

  /**
   * Every occurrence, overlapping ones included (ML-28). Stepping past each
   * match counted `x\nm\nx` once in `x\nm\nx\nm\nx`, and the "unique" search
   * was applied to the first. The spans returned stay non-overlapping, so a
   * count above their number means the occurrences overlap.
   */
  const countOverlapping = (hay: string, needle: string): number => {
    let n = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++;
    return n;
  };

  // ML-41: an exact match whose replacement starts at column 0 while the code
  // it replaces is indented moved that code out of its block (`if not data:`
  // left `load()` and ran at import time; a `return` became module-level).
  // Re-base the replacement onto the search's indentation, keeping its own
  // relative nesting.
  const searchIndent = leadingWhitespace(search);
  const replLines = adapted.split(eol).filter((l) => l.trim() !== '');
  const rebaseFromZero =
    options.rebaseColumnZero === true && searchIndent !== '' && replLines.some((l) => leadingWhitespace(l) === '');

  const exact: EditMatch[] = [];
  for (let from = 0; ; ) {
    const at = text.indexOf(search, from);
    if (at === -1) break;
    let end = at + search.length;
    let replacement = adapted;
    if (splitCrlfAtEnd(end)) {
      end--;
      replacement = withoutTrailingBreak(replacement);
    }
    const atLineStart = at === 0 || text[at - 1] === '\n';
    const rebase = rebaseFromZero && atLineStart;
    if (rebase) replacement = indentAll(replacement, searchIndent, eol);
    exact.push({
      start: absorbSplitCrlf(at),
      end,
      count: 0,
      tier: 'exact',
      replacement,
      ...(rebase ? { rebasedFromColumnZero: true } : {}),
    });
    from = at + search.length;
  }
  if (exact.length > 0) {
    const count = Math.max(exact.length, countOverlapping(text, search));
    return exact.map((m) => ({ ...m, count }));
  }

  const searchLines = applyEol(search, '\n').split('\n');
  // ML-25: a search that ends with the NEXT line's indentation (`foo\n    `)
  // had that indentation dropped as "trailing" whitespace on the lax tiers,
  // while the replacement kept it, so the next line's indent was doubled.
  const endsWithNextIndent = /\n[ \t]+$/.test(applyEol(search, '\n'));

  for (const tier of ['eol', 'trailing-space', 'indent'] as const) {
    const { canon, map } = canonicalize(text, tier);
    const canonSearch = canonicalize(search, tier).canon;
    if (canonSearch === '') continue;
    const found: EditMatch[] = [];
    let occurrences = 0;
    for (let at = canon.indexOf(canonSearch); at !== -1; at = canon.indexOf(canonSearch, at + 1)) occurrences++;
    for (let from = 0; ; ) {
      const ci = canon.indexOf(canonSearch, from);
      if (ci === -1) break;
      from = ci + canonSearch.length;
      let start = map[ci];
      let end = map[ci + canonSearch.length - 1] + 1;
      // A slice handed in by a `within` locator starts at a line start (fs.ts
      // slices there), so offset 0 is a real one.
      const startsAtLine = ci === 0 || canon[ci - 1] === '\n';
      const endsWithBreak = canonSearch.endsWith('\n');
      const endsAtLine =
        !endsWithBreak && (ci + canonSearch.length === canon.length || canon[ci + canonSearch.length] === '\n');

      // The indent tier exists for whole lines whose indentation differs. A
      // match that starts mid-line spliced the model's indentation into the
      // middle of a line (ML-68: `self.            n_components = ...`). A
      // search that starts with a line break begins at a line boundary too.
      if (tier === 'indent' && !startsAtLine && !canonSearch.startsWith('\n')) continue;

      // The tier ignored characters at the edges of the match; pull them back
      // into the span so they are replaced rather than left stranded beside the
      // new text (a `bar   ` where the file had `foo   `, or the old indentation
      // in front of a re-indented block). Not past a line break the search
      // ended with: that pulled in the next, whitespace-only line (ML-26).
      if (endsAtLine) {
        while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      }
      if (endsWithBreak && endsWithNextIndent) {
        while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      }
      if (tier === 'indent' && startsAtLine) {
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
      }
      start = absorbSplitCrlf(start);

      let replacement = adapted;
      if (tier === 'indent') {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const fileLines = applyEol(text.slice(lineStart), '\n').split('\n').slice(0, searchLines.length);
        const levels = alignIndentLevels(searchLines, fileLines);
        if (levels === null) continue; // the search's nesting contradicts the file's
        replacement = reindentByLevels(adapted, levels, searchLines, text, eol);
      }
      found.push({ start, end, count: 0, tier, replacement });
    }
    if (found.length > 0) {
      const count = Math.max(found.length, occurrences);
      return found.map((m) => ({ ...m, count }));
    }
  }

  return [];
}

/**
 * The disclosure for a tolerant match, or '' for an exact one. The model is
 * told what differed so its next search string can be right the first time —
 * silently absorbing the difference would teach it nothing.
 */
export function matchToleranceNote(match: EditMatch, filePath: string, text: string): string {
  if (match.rebasedFromColumnZero) {
    return (
      `[note: your replacement started at column 0, but the code it replaces in ${filePath} is indented. It was ` +
      `indented to match, keeping its own nesting, so it stays inside its block. Verify the result.]\n`
    );
  }
  if (match.tier === 'exact') return '';
  const name = (e: string) => (e === '\r\n' ? 'CRLF' : e === '\r' ? 'CR' : 'LF');
  switch (match.tier) {
    case 'eol':
      return (
        `[note: your search used ${name(detectEol(match.replacement).eol)} line endings and ${filePath} uses ` +
        `${name(detectEol(text).eol)}. It was matched on content, and the replacement was written with the file's ` +
        `line endings.]\n`
      );
    case 'trailing-space':
      return (
        `[note: your search differed from ${filePath} in trailing whitespace only. It was matched on content; ` +
        `copy from read_file (not the 'compact' view, which right-trims) to match byte-for-byte.]\n`
      );
    case 'indent':
      return (
        `[note: your search's indentation did not match ${filePath}. It was matched on content and your ` +
        `replacement was re-indented to the file's indentation. Verify the result.]\n`
      );
  }
}
