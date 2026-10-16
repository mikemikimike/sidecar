// Read and write a workspace file as text the way the file tools do (#165).
//
// fs.ts reads a file in its own encoding and writes edits back the same way
// (fileEncoding.ts). The other places that save a file the agent touched --
// reverting from the edit timeline or the changelog, the keep-best ratchet's
// restore, audit-mode review, the review panel -- read it as UTF-8 and wrote
// it back as UTF-8, so on a Windows-1252 file a revert either garbled what
// fs.ts had kept intact or quietly converted the file to UTF-8.

import { workspace, type Uri } from 'vscode';
import { decodeFile, encodeFile, unencodableChars, UTF8 } from './fileEncoding.js';

/** The file's text, decoded as its bytes say (UTF-8, with or without a BOM, else Windows-1252). */
export async function readTextFile(uri: Uri): Promise<string> {
  return decodeFile(await workspace.fs.readFile(uri)).text;
}

/**
 * Write `text` in the encoding the file has on disk now (its BOM included). A
 * file that does not exist yet is UTF-8. Text the file's encoding cannot store
 * is written as UTF-8 instead: these are restore paths, and losing characters
 * or failing the restore would both be worse than changing the encoding.
 */
export async function writeTextFile(uri: Uri, text: string): Promise<void> {
  let encoding = UTF8;
  try {
    encoding = decodeFile(await workspace.fs.readFile(uri)).encoding;
  } catch {
    // no file yet
  }
  if (unencodableChars(text, encoding).length > 0) encoding = UTF8;
  await workspace.fs.writeFile(uri, encodeFile(text, encoding));
}
