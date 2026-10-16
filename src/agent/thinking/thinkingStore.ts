import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

export type ThinkingMode = 'single' | 'self-debate' | 'tree-of-thought' | 'red-team';

/**
 * Persistent store for thinking blocks from agent loops.
 * Maintains an in-memory ring buffer and persists to `.sidecar/thinking/<taskId>.md`.
 *
 * Each thinking block is appended as a timestamped entry. The first write
 * includes a frontmatter header with the mode selection.
 */
export class ThinkingStore {
  // In-memory ring buffer: Map<taskId, string[]> with max 50 entries per task,
  // for the MAX_TASKS most recent tasks (one store serves every run, and
  // nothing else clears it).
  private buffer = new Map<string, string[]>();
  private readonly MAX_ENTRIES = 50;
  private readonly MAX_TASKS = 20;
  /** Per-task write queue: appends run in order, never concurrently. */
  private writes = new Map<string, Promise<void>>();
  private thinkingDir: string | undefined;

  constructor() {
    // Initialize the thinking directory path lazily from the workspace root
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      this.thinkingDir = path.join(workspaceRoot, '.sidecar', 'thinking');
    }
  }

  /**
   * Append a thinking block to the store.
   * Adds to in-memory buffer and writes to disk asynchronously.
   * @param taskId Unique identifier for the task/session
   * @param content The thinking content (markdown text)
   * @param mode The thinking mode (single, self-debate, tree-of-thought, red-team)
   */
  async append(taskId: string, content: string, mode: ThinkingMode): Promise<void> {
    // Maintain in-memory ring buffer
    if (!this.buffer.has(taskId)) {
      this.buffer.set(taskId, []);
      while (this.buffer.size > this.MAX_TASKS) {
        const oldest = this.buffer.keys().next().value as string;
        this.buffer.delete(oldest);
        this.writes.delete(oldest);
      }
    }

    const entries = this.buffer.get(taskId)!;
    if (entries.length >= this.MAX_ENTRIES) {
      entries.shift(); // Remove oldest entry
    }

    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}]\n${content}`;
    entries.push(entry);

    // Append just this entry, after the task's earlier appends.
    if (this.thinkingDir) {
      const queued = (this.writes.get(taskId) ?? Promise.resolve())
        .then(() => this.appendToDisk(taskId, entry, mode))
        .catch(() => {
          // Silently ignore write errors
        });
      this.writes.set(taskId, queued);
      await queued;
    }
  }

  /**
   * Append one entry to the task's file, writing the frontmatter first when
   * the file does not exist yet (#116). This used to read the file and write
   * back the WHOLE buffer on every append -- and append runs per streamed
   * thinking delta -- so the file repeated itself and grew quadratically, and
   * the fire-and-forget writes raced each other.
   */
  private async appendToDisk(taskId: string, entry: string, mode: ThinkingMode): Promise<void> {
    if (!this.thinkingDir) return;
    const thinkingPath = path.join(this.thinkingDir, `${taskId}.md`);
    await fs.promises.mkdir(this.thinkingDir, { recursive: true });
    let head = '';
    try {
      await fs.promises.access(thinkingPath);
    } catch {
      head = `---\nmode: ${mode}\ntaskId: ${taskId}\ncreatedAt: ${new Date().toISOString()}\n---\n\n`;
    }
    await fs.promises.appendFile(thinkingPath, `${head}${entry}\n\n`, 'utf-8');
  }

  /**
   * Retrieve the thinking history for a task.
   * Returns the in-memory buffer entries.
   */
  get(taskId: string): string[] {
    return this.buffer.get(taskId) || [];
  }

  /**
   * Clear the in-memory buffer for a task (but leave the disk file intact).
   */
  clear(taskId: string): void {
    this.buffer.delete(taskId);
  }
}
