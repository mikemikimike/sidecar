import { TextDocumentContentProvider, Uri, EventEmitter, Event } from 'vscode';

let previewSeq = 0;

/**
 * A key for one preview of `filePath`, unique to that preview (#156 ML-56).
 * Keyed by path alone, two previews of one file shared one document: the
 * second's content replaced the first's in the open diff tab, and disposing
 * either deleted it for both. The path still ends in the file's own name, so
 * the diff editor picks the language from the extension.
 */
export function previewKey(filePath: string): string {
  return `/sidecar-preview-${++previewSeq}/${filePath.replace(/^\/+/, '')}`;
}

export class ProposedContentProvider implements TextDocumentContentProvider {
  private content = new Map<string, string>();
  private _onDidChange = new EventEmitter<Uri>();

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event;
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.content.get(uri.path) ?? '';
  }

  addProposal(key: string, proposedContent: string): Uri {
    // Uri.from, not Uri.parse: parse reads '#' and '?' in a file path as the
    // fragment and query, so uri.path no longer matched the stored key, the
    // proposal read as empty, and the diff showed the whole file deleted.
    const uri = Uri.from({ scheme: 'sidecar-proposed', path: key });
    this.content.set(key, proposedContent);
    this._onDidChange.fire(uri);
    return uri;
  }

  removeProposal(key: string): void {
    this.content.delete(key);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.content.clear();
  }
}
