// Tool calls from a turn that did not finish must not run (#164 ML-15).
//
// A call cut off at the output-token limit arrives with its arguments
// unterminated -- the Anthropic translator keeps the partial JSON as
// `_malformedInputRaw`, the text-form parser does the same for an unclosed
// object -- and the repair tiers then CLOSE the open string and braces, which
// turns "cut off" into "complete but shorter": a write_file for README.md
// truncated mid-content was written as "File written" with everything after
// the cut lost. Repair is right for a model that fumbled JSON syntax; it is
// wrong when the provider says it stopped the model mid-call.
//
// The line is drawn by what the arguments themselves show:
//   - output limit: only calls whose arguments failed to parse are withheld.
//     A call whose JSON closed on its own arrived complete -- the model went
//     on to write more and THAT got cut -- so it runs.
//   - stream ended without its completion signal (stop reason 'error': the
//     connection dropped): every call is withheld. Nothing says the turn the
//     calls belong to finished, and the model is asked again.
// A withheld call keeps its tool_use block and gets an error result saying why
// (the executor short-circuits on `_withheldReason`), so the history stays
// well-formed and the model can re-issue it.

import type { ToolUseContentBlock } from '../../ollama/types.js';

export const CUT_OFF_REASON =
  'Not run: this call was cut off at the output-token limit before its arguments were complete, so nothing was ' +
  'executed or written. Re-issue it in full; if it carries a large file or edit, split it into smaller parts ' +
  '(write the file in sections, or make several smaller edits).';

export const STREAM_ENDED_REASON =
  'Not run: the response stream ended before the model finished (no completion signal arrived — the connection ' +
  'may have dropped), so this call may be incomplete and nothing was executed. Re-issue it if it is still needed.';

/**
 * Mark the calls that must not run, given the RAW stop reason of the turn that
 * produced them (before text-form parsing rewrites it to 'tool_use'). Returns
 * how many were withheld.
 */
export function withholdUnfinishedToolCalls(toolUses: readonly ToolUseContentBlock[], stopReason: string): number {
  let withheld = 0;
  for (const tu of toolUses) {
    if (stopReason === 'error') {
      tu._withheldReason = STREAM_ENDED_REASON;
    } else if (stopReason === 'max_tokens' && tu._malformedInputRaw !== undefined) {
      tu._withheldReason = CUT_OFF_REASON;
    } else {
      continue;
    }
    withheld++;
  }
  return withheld;
}
