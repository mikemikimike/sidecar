import type { Memento } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';
import { serializeContent } from '../ollama/types.js';

export interface SavedSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** ID of the parent session this was branched from, if any. */
  parentId?: string;
  /** Index into the parent's message array at the time of branching. */
  branchPoint?: number;
}

const STORAGE_KEY = 'sidecar.sessions';
let _idCounter = 0;
function newSessionId(): string {
  return `session_${Date.now()}_${++_idCounter}`;
}

/**
 * Listeners told after any SessionManager writes. Module-level because the
 * chat and the Sessions view each hold their own manager over the same
 * storage, and the view only refreshed after its own commands -- a save from
 * the chat never appeared (#120).
 */
const changeListeners = new Set<() => void>();

/** Subscribe to session-list changes; returns the unsubscribe function. */
export function onDidChangeSessions(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export class SessionManager {
  constructor(private globalState: Memento) {}

  private store(sessions: SavedSession[]): void {
    this.globalState.update(STORAGE_KEY, sessions);
    for (const listener of changeListeners) listener();
  }

  save(name: string, messages: ChatMessage[]): SavedSession {
    const sessions = this.list();
    // Serialize messages preserving tool calls/results, stripping images
    const cleanMessages = messages.map((m) => ({
      role: m.role,
      content: serializeContent(m.content),
    }));

    const session: SavedSession = {
      id: newSessionId(),
      name,
      messages: cleanMessages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    sessions.push(session);
    this.store(sessions);
    return session;
  }

  list(): SavedSession[] {
    return this.globalState.get<SavedSession[]>(STORAGE_KEY, []);
  }

  load(id: string): SavedSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  /**
   * Update an existing session's messages in place.
   * Returns false if the session was not found.
   */
  update(id: string, messages: ChatMessage[]): boolean {
    const sessions = this.list();
    const session = sessions.find((s) => s.id === id);
    if (!session) return false;

    session.messages = messages.map((m) => ({
      role: m.role,
      content: serializeContent(m.content),
    }));
    session.updatedAt = Date.now();
    this.store(sessions);
    return true;
  }

  rename(id: string, newName: string): boolean {
    const sessions = this.list();
    const session = sessions.find((s) => s.id === id);
    if (!session) return false;
    session.name = newName;
    session.updatedAt = Date.now();
    this.store(sessions);
    return true;
  }

  /**
   * Fork a session at a given message index. The child starts with a copy
   * of messages[0..atMessage] and is linked to the parent via `parentId`.
   * Returns the new child session.
   */
  branch(parentId: string, name: string, messages: ChatMessage[]): SavedSession {
    const sessions = this.list();
    const parent = sessions.find((s) => s.id === parentId);

    const child: SavedSession = {
      id: newSessionId(),
      name,
      messages: messages.map((m) => ({ role: m.role, content: serializeContent(m.content) })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentId,
      branchPoint: parent ? parent.messages.length : undefined,
    };

    sessions.push(child);
    this.store(sessions);
    return child;
  }

  /** Return all direct children of a session. */
  listChildren(parentId: string): SavedSession[] {
    return this.list().filter((s) => s.parentId === parentId);
  }

  delete(id: string): void {
    const sessions = this.list().filter((s) => s.id !== id);
    this.store(sessions);
  }
}
