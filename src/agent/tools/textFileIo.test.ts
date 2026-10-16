import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readTextFile, writeTextFile } from './textFileIo.js';
import { ChangeLog } from '../changelog.js';

// #165 follow-up: the restore paths (changelog rollback, edit-timeline revert,
// keep-best ratchet, audit review, review panel) keep a file's encoding.

vi.mock('vscode', () => {
  const files = new Map<string, Buffer>();
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/project' } }],
      fs: {
        readFile: vi.fn(async (uri: { path: string }) => {
          const b = files.get(uri.path);
          if (!b) throw new Error('File not found');
          return b;
        }),
        writeFile: vi.fn(async (uri: { path: string }, data: Uint8Array) => {
          files.set(uri.path, Buffer.from(data));
        }),
        delete: vi.fn(async (uri: { path: string }) => {
          files.delete(uri.path);
        }),
      },
    },
    Uri: {
      joinPath: (_base: unknown, ...segments: string[]) => ({ path: '/project/' + segments.join('/') }),
    },
    __files: files,
  };
});

import * as vscode from 'vscode';
const files = (vscode as unknown as { __files: Map<string, Buffer> }).__files;
const uri = (p: string) => ({ path: '/project/' + p }) as never;

// "café €5\r\n" in Windows-1252.
const CP1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x0d, 0x0a]);

beforeEach(() => files.clear());

describe('readTextFile / writeTextFile', () => {
  it('reads a cp1252 file as text and writes it back in cp1252', async () => {
    files.set('/project/a.txt', CP1252);
    const text = await readTextFile(uri('a.txt'));
    expect(text).toBe('café €5\r\n');
    await writeTextFile(uri('a.txt'), text.replace('5', '6'));
    expect(files.get('/project/a.txt')).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x36, 0x0d, 0x0a]));
  });

  it('keeps a UTF-8 BOM, and writes a new file as plain UTF-8', async () => {
    files.set('/project/b.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    await writeTextFile(uri('b.txt'), 'é');
    expect(files.get('/project/b.txt')).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9]));
    await writeTextFile(uri('new.txt'), 'é');
    expect(files.get('/project/new.txt')).toEqual(Buffer.from('é', 'utf-8'));
  });

  it('writes text a cp1252 file cannot store as UTF-8 rather than losing it', async () => {
    files.set('/project/c.txt', CP1252);
    await writeTextFile(uri('c.txt'), 'a → b');
    expect(files.get('/project/c.txt')!.toString('utf-8')).toBe('a → b');
  });
});

describe('a restore through the changelog', () => {
  it('rolls a cp1252 file back to its exact original bytes', async () => {
    files.set('/project/legacy.txt', CP1252);
    const log = new ChangeLog();
    await log.snapshotFile('legacy.txt');
    // An edit, written the way edit_file writes it: still cp1252.
    await writeTextFile(uri('legacy.txt'), 'café €9\r\n');
    expect(await log.rollbackFile('legacy.txt')).toBe(true);
    expect(files.get('/project/legacy.txt')).toEqual(CP1252);
  });
});
