import { describe, it, expect, vi } from 'vitest';
import { openDiffPreview } from './streamingDiffPreview.js';
import { ProposedContentProvider } from './proposedContentProvider.js';
import { workspace, window, commands } from 'vscode';

describe('openDiffPreview', () => {
  it('throws when no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn();

    await expect(openDiffPreview('app.ts', 'content', provider, confirmFn)).rejects.toThrow('No workspace folder open');

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('returns a session with update, finalize, and dispose', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'initial content', provider, confirmFn);

    expect(session.update).toBeDefined();
    expect(session.finalize).toBeDefined();
    expect(session.dispose).toBeDefined();
  });

  /** The proposed-content URI a session opened its diff with. */
  const openedUri = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls.at(-1) as unknown[])[2] as { path: string };

  it('update changes the proposed content', async () => {
    const diff = vi.spyOn(commands, 'executeCommand');
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'v1', provider, confirmFn);
    session.update('v2');

    // Verify the provider got updated content
    expect(provider.provideTextDocumentContent(openedUri(diff) as never)).toBe('v2');
    expect(openedUri(diff).path).toMatch(/\/app\.ts$/); // keeps the extension for language detection

    session.dispose();
    diff.mockRestore();
  });

  // #156 ML-56: two cautious previews of one file shared one document.
  it('two previews of the same file each keep their own content, and disposing one keeps the other', async () => {
    const diff = vi.spyOn(commands, 'executeCommand');
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const a = await openDiffPreview('app.ts', 'edit A', provider, confirmFn);
    const uriA = openedUri(diff);
    const b = await openDiffPreview('app.ts', 'edit B', provider, confirmFn);
    const uriB = openedUri(diff);

    expect(uriA.path).not.toBe(uriB.path);
    expect(provider.provideTextDocumentContent(uriA as never)).toBe('edit A');
    expect(provider.provideTextDocumentContent(uriB as never)).toBe('edit B');
    a.dispose();
    expect(provider.provideTextDocumentContent(uriB as never)).toBe('edit B');
    b.dispose();
    diff.mockRestore();
  });

  it('finalize returns accept when user accepts via editor notification', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const provider = new ProposedContentProvider();
    // Chat confirm never resolves — editor notification wins the race
    const confirmFn = vi.fn().mockReturnValue(new Promise(() => {}));

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('accept');
    session.dispose();
  });

  it('finalize returns accept when user accepts via chat confirm', async () => {
    // Editor notification never resolves — chat confirm wins the race
    vi.spyOn(window, 'showInformationMessage').mockReturnValue(new Promise(() => {}) as never);
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('accept');
    session.dispose();
  });

  it('suppresses the editor toast when the chat view is visible (double-prompt fix)', async () => {
    const toastSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn, () => true);
    toastSpy.mockClear();
    const result = await session.finalize();
    expect(result).toBe('accept');
    // Chat visible → the chat card is the ONLY approval surface.
    expect(toastSpy).not.toHaveBeenCalled();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('keeps the toast fallback when the chat view is hidden', async () => {
    const toastSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockReturnValue(new Promise(() => {}));

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn, () => false);
    const result = await session.finalize();
    expect(result).toBe('accept');
    expect(toastSpy).toHaveBeenCalled();
    session.dispose();
  });

  it('finalize returns reject when user rejects', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Reject' as never);
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockReturnValue(new Promise(() => {}));

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('reject');
    session.dispose();
  });

  it('finalize returns reject when user dismisses notification', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockReturnValue(new Promise(() => {}));

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('reject');
    session.dispose();
  });

  it('dispose cleans up the proposal', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn();

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    session.dispose();

    const uri = { path: '/app.ts' } as never;
    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });
});
