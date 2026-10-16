import * as vscode from 'vscode';
import type { SideCarClient } from '../ollama/client.js';

interface Repository {
  inputBox: { value: string };
  diff(staged: boolean): Promise<string>;
}

interface GitExtension {
  getAPI(version: 1): { repositories: Repository[] };
}

export async function suggestCommitMessage(createClient: () => SideCarClient): Promise<void> {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    vscode.window.showErrorMessage('SideCar: git extension not found.');
    return;
  }
  const gitApi = gitExt.exports.getAPI(1);
  const repo = gitApi.repositories[0];
  if (!repo) {
    vscode.window.showErrorMessage('SideCar: no git repository found.');
    return;
  }

  const diff = await repo.diff(true);
  if (!diff.trim()) {
    vscode.window.showInformationMessage('SideCar: No staged changes.');
    return;
  }

  // 400 chars was a few lines of the first file, so the message described a
  // fraction of the change (#118).
  const MAX_DIFF_CHARS = 8000;
  const shownDiff = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
  const prompt = `Write a conventional-commit message (type(scope): subject, then a blank line and bullet body if needed) for these staged changes. Max 100 chars subject. Output ONLY the commit message:\n\n\`\`\`diff\n${shownDiff}\n\`\`\``;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SideCar: generating commit message…',
      cancellable: true,
    },
    async (_progress, token) => {
      const abortController = new AbortController();
      token.onCancellationRequested(() => abortController.abort());

      const client = createClient();
      let message = '';

      for await (const event of client.streamChat(
        [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        abortController.signal,
      )) {
        if (event.type === 'text') {
          message += event.text;
        }
      }

      repo.inputBox.value = message.trim();
    },
  );
}
