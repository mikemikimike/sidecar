// A search whose lines are all in the file, in order, but not next to each
// other: the model left out a line between two it kept -- usually a comment
// or a blank line it judged irrelevant (`const format = …` / `// Use the
// truncate function from it` / `const truncate = …`). In a week of eval runs,
// that was the commonest shape of "search not found" where the content was
// known (13 of 48). The generic hints guess at a region; here the region is
// certain, so the message can name it and the lines that were skipped.

/** How many consecutive file lines a search may skip between two of its own lines. */
const MAX_GAP = 3;

export interface SkippedLinesMatch {
  /** The exact text of the file region the search describes, in the file's line endings. */
  region: string;
  /** The lines the search left out, with their 1-based line numbers. */
  skipped: { line: number; text: string }[];
}

/**
 * The single file region whose lines are the search's lines in order with at
 * most MAX_GAP extra lines between any two, when at least one line was
 * skipped. Null when there is no such region, or more than one (then the
 * location is not certain and the caller's other hints apply).
 */
export function findSkippedLinesMatch(text: string, search: string): SkippedLinesMatch | null {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const fileLines = text.split(/\r?\n/);
  const want = search
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());
  while (want.length > 0 && want[0] === '') want.shift();
  while (want.length > 0 && want[want.length - 1] === '') want.pop();
  if (want.filter((l) => l !== '').length < 2) return null;

  const found: { start: number; end: number; skipped: number[] }[] = [];
  for (let start = 0; start < fileLines.length; start++) {
    if (fileLines[start].trim() !== want[0]) continue;
    let at = start;
    const skipped: number[] = [];
    let ok = true;
    for (let k = 1; k < want.length && ok; k++) {
      let next = at + 1;
      while (next < fileLines.length && next - at - 1 <= MAX_GAP && fileLines[next].trim() !== want[k]) next++;
      if (next >= fileLines.length || next - at - 1 > MAX_GAP) ok = false;
      else {
        for (let g = at + 1; g < next; g++) skipped.push(g);
        at = next;
      }
    }
    if (ok && skipped.length > 0) found.push({ start, end: at, skipped });
  }
  if (found.length !== 1) return null;
  const [m] = found;
  return {
    region: fileLines.slice(m.start, m.end + 1).join(eol),
    skipped: m.skipped.map((i) => ({ line: i + 1, text: fileLines[i] })),
  };
}

/** The error for a search that skipped lines. */
export function skippedLinesError(filePath: string, m: SkippedLinesMatch): string {
  const listed = m.skipped
    .slice(0, 5)
    .map((s) => `  line ${s.line}: ${s.text.trim() === '' ? '(blank line)' : s.text.trim()}`)
    .join('\n');
  const more = m.skipped.length > 5 ? `\n  …and ${m.skipped.length - 5} more` : '';
  return (
    `Error: edit_file failed — your 'search' text is not in ${filePath} as one block: every line of it is there, ` +
    `in order, but it leaves out ${m.skipped.length === 1 ? 'a line' : `${m.skipped.length} lines`} that sit between ` +
    `them:\n${listed}${more}\nThe file was NOT modified.\n\nThe file has exactly this text there:\n\`\`\`\n${m.region}\n\`\`\`\n\n` +
    `Use that block as 'search'. In 'replace', keep the skipped line${m.skipped.length === 1 ? '' : 's'} unless you ` +
    `mean to delete ${m.skipped.length === 1 ? 'it' : 'them'} — anything in 'search' that is missing from 'replace' is deleted.`
  );
}
