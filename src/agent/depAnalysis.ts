import { workspace, Uri } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Analyze project dependencies — works for Node.js projects.
 * Returns dependency counts, lists, and checks for unused deps.
 */
export async function analyzeDependencies(): Promise<string> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return 'No workspace folder open.';
  const cwd = rootUri.fsPath;

  // Try package.json first (Node.js)
  try {
    const pkgBytes = await workspace.fs.readFile(Uri.joinPath(rootUri, 'package.json'));
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
    return await analyzeNodeDeps(pkg, cwd);
  } catch {
    // no package.json
  }

  // Try pyproject.toml (Python)
  try {
    await workspace.fs.stat(Uri.joinPath(rootUri, 'pyproject.toml'));
    return await analyzePythonDeps(cwd);
  } catch {
    // not found
  }

  // Try go.mod (Go)
  try {
    await workspace.fs.stat(Uri.joinPath(rootUri, 'go.mod'));
    return await analyzeGoDeps(cwd);
  } catch {
    // not found
  }

  return 'No supported package manifest found (package.json, pyproject.toml, go.mod).';
}

async function analyzeNodeDeps(pkg: Record<string, unknown>, cwd: string): Promise<string> {
  const deps = Object.keys((pkg.dependencies as Record<string, string>) || {});
  const devDeps = Object.keys((pkg.devDependencies as Record<string, string>) || {});

  const lines = [
    '# Dependency Analysis',
    '',
    `**Package:** ${pkg.name || 'unknown'}`,
    `**Version:** ${pkg.version || 'unknown'}`,
    '',
    '## Summary',
    '',
    `| Type | Count |`,
    `|------|-------|`,
    `| Production | ${deps.length} |`,
    `| Development | ${devDeps.length} |`,
    `| **Total** | **${deps.length + devDeps.length}** |`,
  ];

  if (deps.length > 0) {
    lines.push('', '## Production Dependencies', '');
    for (const d of deps.sort()) {
      const ver = (pkg.dependencies as Record<string, string>)[d];
      lines.push(`- \`${d}\` ${ver}`);
    }
  }

  if (devDeps.length > 0) {
    lines.push('', '## Dev Dependencies', '');
    for (const d of devDeps.sort()) {
      const ver = (pkg.devDependencies as Record<string, string>)[d];
      lines.push(`- \`${d}\` ${ver}`);
    }
  }

  // Check for unused deps by scanning source files for imports
  try {
    const unusedProd = await findUnusedNodeDeps(deps, cwd);
    if (unusedProd.length > 0) {
      lines.push('', '## Potentially Unused (production)', '');
      lines.push('> These packages are in dependencies but no import was found in `src/`:');
      lines.push('');
      for (const d of unusedProd) lines.push(`- \`${d}\``);
    }
  } catch {
    // skip unused check
  }

  // Check for outdated
  try {
    const outdated = JSON.parse((await npmOutdatedJson(cwd)) || '{}');
    const entries = Object.entries(outdated);
    if (entries.length > 0) {
      lines.push('', '## Outdated Packages', '');
      lines.push('| Package | Current | Wanted | Latest |');
      lines.push('|---------|---------|--------|--------|');
      for (const [name, info] of entries) {
        const i = info as { current?: string; wanted?: string; latest?: string };
        lines.push(`| ${name} | ${i.current || '?'} | ${i.wanted || '?'} | ${i.latest || '?'} |`);
      }
    }
  } catch {
    // npm missing, offline, or unparseable output
  }

  return lines.join('\n');
}

/**
 * `npm outdated --json`'s report. npm exits 1 whenever anything IS outdated,
 * so the report arrives on the rejection -- reading only the success path
 * dropped the section in exactly the case it exists for (#117).
 */
async function npmOutdatedJson(cwd: string): Promise<string> {
  try {
    return (await execAsync('npm outdated --json', { cwd, timeout: 30_000 })).stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout?.trim()) return stdout;
    throw err;
  }
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out']);

async function readSources(dir: string, into: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await readSources(full, into);
    } else if (SOURCE_EXT.test(entry.name)) {
      into.push(await fs.readFile(full, 'utf-8'));
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Production deps no file under `src/` imports. Searched in-process: this
 * shelled out to `grep`, which Windows doesn't have, and the ENOENT was read
 * as "no match" -- so every dependency was reported unused (#117). A dep
 * counts as used when it appears as a quoted module specifier (`'pkg'` or
 * `'pkg/sub'`), not merely as a substring somewhere in the text.
 */
export async function findUnusedNodeDeps(deps: string[], cwd: string): Promise<string[]> {
  const sources: string[] = [];
  try {
    await readSources(path.join(cwd, 'src'), sources);
  } catch {
    return []; // no src/ -- nothing to judge by, so claim nothing
  }
  const text = sources.join('\n');
  return deps.filter((dep) => !new RegExp(`['"\`]${escapeRegExp(dep)}(/[^'"\`]*)?['"\`]`).test(text));
}

async function analyzePythonDeps(cwd: string): Promise<string> {
  const lines = ['# Dependency Analysis (Python)', ''];
  try {
    const { stdout } = await execAsync('pip list --format=json', { cwd, timeout: 15_000 });
    const pkgs = JSON.parse(stdout) as { name: string; version: string }[];
    lines.push(`**Installed packages:** ${pkgs.length}`, '');
    lines.push('| Package | Version |');
    lines.push('|---------|---------|');
    for (const p of pkgs.slice(0, 50)) {
      lines.push(`| ${p.name} | ${p.version} |`);
    }
    if (pkgs.length > 50) lines.push(`| ... and ${pkgs.length - 50} more | |`);
  } catch {
    lines.push('Could not list Python packages. Is pip installed?');
  }
  return lines.join('\n');
}

async function analyzeGoDeps(cwd: string): Promise<string> {
  const lines = ['# Dependency Analysis (Go)', ''];
  try {
    const { stdout } = await execAsync('go list -m all', { cwd, timeout: 15_000 });
    const mods = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes(' '));
    lines.push(`**Module dependencies:** ${mods.length}`, '');
    lines.push('| Module | Version |');
    lines.push('|--------|---------|');
    for (const m of mods.slice(0, 50)) {
      const [name, ver] = m.split(' ');
      lines.push(`| ${name} | ${ver || '?'} |`);
    }
    if (mods.length > 50) lines.push(`| ... and ${mods.length - 50} more | |`);
  } catch {
    lines.push('Could not list Go modules. Is go installed?');
  }
  return lines.join('\n');
}
