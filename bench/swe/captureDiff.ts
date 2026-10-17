import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A touched path left out of the capture, and why. */
export interface DroppedPath {
  path: string;
  reason: 'outside-repo' | 'missing-untracked' | 'ignored';
}

export interface CapturedDiff {
  patch: string;
  dropped: DroppedPath[];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** True when `git` exits 0 -- for the commands whose answer IS the exit code. */
function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's final patch: `git diff` of base_commit against the working tree,
 * scoped to the files the agent edited, wrote or deleted.
 *
 * Scoping to `touchedPaths` makes the capture immune to repo-state drift: any
 * drift (a stray `git` in the agent's shell, an env-setup step, two eval
 * processes sharing one cached clone and issuing conflicting `git reset`s) used
 * to explode a whole-repo diff to hundreds of unrelated files (django-10914: a
 * clean one-line fix came back as a 475KB / 256-file "patch"). base_commit stays
 * the reference so a committed fix is still captured (django-11848). Edited-then
 * -reverted files diff to nothing and drop out.
 *
 * `touchedPaths` records every mutation CALL, successful or not, and later shell
 * activity never removes one. A single path `git add` rejects made it exit 128
 * and nothing was staged -- the caller swallowed that as an empty patch, losing
 * every valid edit with it. So each path is vetted first, and dropped when:
 *   - it resolves outside the clone (`write_file /tmp/x.py`, refused by the tool
 *     but still recorded),
 *   - it is missing on disk and not tracked at base_commit (a scratch test the
 *     agent wrote and later `rm`'d),
 *   - it is untracked and gitignored (matplotlib's generated `_version.py`).
 * A tracked path that is now missing is KEPT: it is a real deletion and must
 * diff as one.
 */
export function captureDiff(dir: string, baseCommit: string, touchedPaths: Iterable<string>): CapturedDiff {
  const root = path.resolve(dir);
  const kept = new Set<string>();
  const dropped: DroppedPath[] = [];
  for (const raw of new Set(touchedPaths)) {
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      dropped.push({ path: raw, reason: 'outside-repo' });
      continue;
    }
    const posix = rel.split(path.sep).join('/');
    if (posix === '.git' || posix.startsWith('.git/')) {
      dropped.push({ path: raw, reason: 'outside-repo' });
      continue;
    }
    const tracked = gitSucceeds(['cat-file', '-e', `${baseCommit}:${posix}`], root);
    if (!tracked && !fs.existsSync(abs)) {
      dropped.push({ path: raw, reason: 'missing-untracked' });
      continue;
    }
    if (!tracked && gitSucceeds(['check-ignore', '-q', '--', posix], root)) {
      dropped.push({ path: raw, reason: 'ignored' });
      continue;
    }
    kept.add(posix);
  }
  if (kept.size === 0) return { patch: '', dropped };
  const paths = [...kept];
  git(['add', '-A', '--', ...paths], root);
  return { patch: git(['diff', '--cached', baseCommit, '--', ...paths], root), dropped };
}
