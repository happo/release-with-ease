import { spawnSync } from 'node:child_process';
import path from 'node:path';

import * as tmpfs from './tmpfs.ts';

/**
 * Builds real git repositories for tests to run against, rather than
 * pretending git said something. The work tree gets an `origin` bare repo
 * beside it so the default-branch and in-sync checks have something true to
 * check.
 *
 * Call `tmpfs.mock()` first and `tmpfs.restore()` after.
 */
const WORK = 'work';
const ORIGIN = 'origin.git';

function git(args: Array<string>, cwd: string = tmpfs.fullPath(WORK)): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      // Keep a developer's own git config out of the fixtures: a global
      // commit.gpgsign or merge.ff would otherwise change what these build.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export interface Repo {
  /** Runs git in the work tree and returns stdout. */
  git: (...args: Array<string>) => string;
  /** Full SHA for a revision. */
  sha: (rev: string) => string;
  /** Writes a file, stages it, and commits. Returns the new commit's SHA. */
  commit: (files: Record<string, string>, message: string) => string;
  /** Pushes the current state of main to origin and points origin/HEAD at it. */
  publish: () => void;
  /** Absolute path to the work tree. */
  dir: string;
}

/**
 * Creates `origin.git` and a `work` clone of it with one commit on `main`,
 * then chdirs into the work tree.
 */
export function initRepo(): Repo {
  tmpfs.exec('git', ['init', '--bare', '--initial-branch=main', ORIGIN]);
  tmpfs.exec('git', ['init', '--initial-branch=main', WORK]);

  const dir = tmpfs.fullPath(WORK);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['remote', 'add', 'origin', path.join('..', ORIGIN)]);

  const repo: Repo = {
    git: (...args) => git(args),
    sha: rev => git(['rev-parse', rev]).trim(),
    commit: (files, message) => {
      for (const [name, content] of Object.entries(files)) {
        tmpfs.writeFile(path.join(WORK, name), content);
      }
      git(['add', '-A']);
      git(['commit', '-m', message]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    publish: () => {
      git(['push', '--force', 'origin', 'main']);
      git(['remote', 'set-head', 'origin', 'main']);
    },
    dir,
  };

  repo.commit({ 'README.md': '# Test\n' }, 'Initial commit');
  repo.publish();
  process.chdir(dir);
  return repo;
}

export interface Stack {
  mergeSha: string;
  bottomHeadSha: string;
  topHeadSha: string;
  bottomBranch: string;
  topBranch: string;
}

/**
 * Reproduces what GitHub leaves behind when a two-deep stack is merged: the
 * top pull request's branch is built on the bottom one's, and the whole stack
 * arrives on main as a single merge commit.
 */
export function mergeTwoDeepStack(
  repo: Repo,
  options: {
    bottomBranch?: string;
    topBranch?: string;
    bottomFiles: Record<string, string>;
    topFiles: Record<string, string>;
    mergeMessage?: string;
  },
): Stack {
  const bottomBranch = options.bottomBranch ?? 'feature-bottom';
  const topBranch = options.topBranch ?? 'feature-top';

  repo.git('checkout', '-b', bottomBranch, 'main');
  const bottomHeadSha = repo.commit(options.bottomFiles, 'Bottom of the stack');

  repo.git('checkout', '-b', topBranch, bottomBranch);
  const topHeadSha = repo.commit(options.topFiles, 'Top of the stack');

  repo.git('checkout', 'main');
  repo.git(
    'merge',
    '--no-ff',
    topBranch,
    '-m',
    options.mergeMessage ?? `Top of the stack (#2)`,
  );
  const mergeSha = repo.sha('HEAD');
  repo.publish();

  return { mergeSha, bottomHeadSha, topHeadSha, bottomBranch, topBranch };
}
