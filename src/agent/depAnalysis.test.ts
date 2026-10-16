/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeDependencies, findUnusedNodeDeps } from './depAnalysis.js';
import * as cp from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock vscode workspace
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  Uri: {
    joinPath: vi.fn((base, path) => ({ fsPath: `/test/${path}` })),
  },
}));

// Mock child_process — exec and execFile both fail by default so no
// real subprocesses run in tests. Real promisify is used intentionally
// so promisify(execFile)(file, args, opts) passes all args correctly.
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => {
    process.nextTick(() => cb(new Error('exec disabled in tests')));
  }),
  execFile: vi.fn((cmd, args, opts, cb) => {
    process.nextTick(() => cb(new Error('execFile disabled in tests')));
  }),
}));

import * as vscode from 'vscode';

const mockWorkspace = vscode.workspace as any;

describe('analyzeDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockWorkspace as any).workspaceFolders = [];
  });

  it('returns error message when no workspace is open', async () => {
    (mockWorkspace as any).workspaceFolders = [];
    const result = await analyzeDependencies();
    expect(result).toContain('No workspace folder open');
  });

  it('analyzes Node.js project', async () => {
    const mockPackage = {
      name: 'test-project',
      version: '1.0.0',
    };

    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(Buffer.from(JSON.stringify(mockPackage)));

    const result = await analyzeDependencies();
    expect(result).toContain('test-project');
    expect(result).toContain('1.0.0');
  });

  it('displays markdown headers', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'my-app', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('# Dependency Analysis');
    expect(result).toContain('## Summary');
  });

  it('includes dependency table', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'test', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('|');
    expect(result).toContain('Type');
  });

  it('counts zero dependencies', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'my-app', version: '2.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('Production | 0');
    expect(result).toContain('Development | 0');
  });

  it('handles missing package.json', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

    const result = await analyzeDependencies();
    expect(result).toContain('No supported package manifest found');
  });

  it('handles invalid JSON', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValueOnce(Buffer.from('invalid'));
    vi.mocked(vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

    const result = await analyzeDependencies();
    expect(result).toContain('No supported package manifest found');
  });

  it('creates markdown output', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'test-app', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toMatch(/# Dependency Analysis/);
    expect(result).toMatch(/\|.*Type.*Count/);
  });

  it('lists production and dev dependencies when present', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          name: 'my-app',
          version: '1.0.0',
          dependencies: { express: '^4.18.0', lodash: '^4.17.0' },
          devDependencies: { vitest: '^0.34.0' },
        }),
      ),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('express');
    expect(result).toContain('lodash');
    expect(result).toContain('vitest');
    expect(result).toContain('Production | 2');
    expect(result).toContain('Development | 1');
  });

  it('falls back to Python when pyproject.toml is found', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
    // package.json read fails
    vi.mocked(vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
    // pyproject.toml stat succeeds
    vi.mocked(vscode.workspace.fs.stat as any).mockResolvedValueOnce({ type: 1, size: 100 });

    const result = await analyzeDependencies();
    expect(result).toContain('Python');
  });

  it('falls back to Go when go.mod is found', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
    vi.mocked(vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
    // pyproject.toml stat fails, go.mod stat succeeds
    vi.mocked(vscode.workspace.fs.stat as any)
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce({ type: 1, size: 100 });

    const result = await analyzeDependencies();
    expect(result).toContain('Go');
  });
});

// #117: the unused-deps check shelled out to grep (absent on Windows, and its
// ENOENT read as "unused"), and `npm outdated` reports on a non-zero exit.
describe('Node dependency checks (#117)', () => {
  it('finds imports in src/ without a grep binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-'));
    try {
      mkdirSync(join(root, 'src', 'lib'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), "import express from 'express';\n");
      writeFileSync(join(root, 'src', 'lib', 'b.js'), "const fp = require('lodash/fp');\n");
      writeFileSync(join(root, 'src', 'c.ts'), '// mentions chalk in a comment only\n');
      const unused = await findUnusedNodeDeps(['express', 'lodash', 'chalk', 'left-pad'], root);
      expect(unused).toEqual(['chalk', 'left-pad']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims nothing when there is no src/ to search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-'));
    try {
      expect(await findUnusedNodeDeps(['express'], root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports outdated packages although npm outdated exits 1', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { express: '^4.0.0' } })),
    );
    vi.mocked(cp.exec as any).mockImplementationOnce((_cmd: string, _opts: unknown, cb: any) => {
      const err = Object.assign(new Error('Command failed: npm outdated --json'), {
        code: 1,
        stdout: JSON.stringify({ express: { current: '4.0.0', wanted: '4.21.0', latest: '5.1.0' } }),
      });
      process.nextTick(() => cb(err));
    });
    const result = await analyzeDependencies();
    expect(result).toContain('## Outdated Packages');
    expect(result).toContain('| express | 4.0.0 | 4.21.0 | 5.1.0 |');
  });
});
