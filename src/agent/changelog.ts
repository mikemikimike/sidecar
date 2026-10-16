import { workspace, Uri } from 'vscode';
import { readTextFile, writeTextFile } from './tools/textFileIo.js';

export interface FileChange {
  filePath: string;
  originalContent: string | null; // null if file was newly created
  timestamp: number;
}

export class ChangeLog {
  private changes: FileChange[] = [];

  async snapshotFile(filePath: string): Promise<void> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return;

    // Check if we already have a snapshot for this file in this session
    if (this.changes.some((c) => c.filePath === filePath)) return;

    const fileUri = Uri.joinPath(rootUri, filePath);
    let originalContent: string | null = null;
    try {
      originalContent = await readTextFile(fileUri);
    } catch {
      // File doesn't exist yet — will be a new creation
      originalContent = null;
    }

    this.changes.push({
      filePath,
      originalContent,
      timestamp: Date.now(),
    });
  }

  getChanges(): FileChange[] {
    return [...this.changes];
  }

  hasChanges(): boolean {
    return this.changes.length > 0;
  }

  async rollbackAll(): Promise<{ restored: number; deleted: number; failed: number }> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return { restored: 0, deleted: 0, failed: 0 };

    let restored = 0;
    let deleted = 0;
    let failed = 0;

    // Process in reverse order (undo latest changes first)
    for (const change of [...this.changes].reverse()) {
      try {
        const fileUri = Uri.joinPath(rootUri, change.filePath);
        if (change.originalContent === null) {
          // File was newly created — delete it
          await workspace.fs.delete(fileUri);
          deleted++;
        } else {
          // File existed before — restore original content
          await writeTextFile(fileUri, change.originalContent);
          restored++;
        }
      } catch {
        failed++;
      }
    }

    this.changes = [];
    return { restored, deleted, failed };
  }

  async rollbackFile(filePath: string): Promise<boolean> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return false;

    const change = this.changes.find((c) => c.filePath === filePath);
    if (!change) return false;

    try {
      const fileUri = Uri.joinPath(rootUri, filePath);
      if (change.originalContent === null) {
        await workspace.fs.delete(fileUri);
      } else {
        await writeTextFile(fileUri, change.originalContent);
      }
      this.changes = this.changes.filter((c) => c.filePath !== filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getChangeSummary(): Promise<{ filePath: string; original: string | null; current: string | null }[]> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return [];

    const results: { filePath: string; original: string | null; current: string | null }[] = [];

    for (const change of this.changes) {
      let current: string | null = null;
      try {
        const fileUri = Uri.joinPath(rootUri, change.filePath);
        current = await readTextFile(fileUri);
      } catch {
        // File was deleted after being tracked
        current = null;
      }
      results.push({
        filePath: change.filePath,
        original: change.originalContent,
        current,
      });
    }

    return results;
  }

  clear(): void {
    this.changes = [];
  }
}
