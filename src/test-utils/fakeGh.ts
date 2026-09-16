import fs from 'node:fs';
import path from 'node:path';

import * as tmpfs from './tmpfs.ts';

/**
 * Puts a `gh` on PATH that answers from canned files.
 *
 * The code under test shells out to `gh` through `execSync`, so the honest
 * place to stand in for GitHub is a real executable on PATH — the command
 * string, the argument parsing and the JSON round trip all stay real, and
 * nothing in `src/` has to grow a seam it would not otherwise have.
 *
 * A response left undefined makes that subcommand exit non-zero, which is
 * how `gh` behaves when it is unauthenticated or the repository is unknown.
 */
export interface FakeGhOptions {
  nameWithOwner?: string;
  /** Rows of [sha, login] returned by the compare API. */
  compare?: Array<[string, string]>;
  /** Raw value for `gh pr list --json ...`; a string is emitted verbatim. */
  prList?: unknown;
  /** Value for `gh repo view --json defaultBranchRef`. */
  defaultBranch?: string;
}

let originalPath: string | undefined;

export function install(options: FakeGhOptions = {}): void {
  if (originalPath !== undefined) {
    throw new Error('fakeGh.install() called before fakeGh.restore()');
  }

  const binDir = tmpfs.fullPath('fake-bin');
  const dataDir = tmpfs.fullPath('fake-bin-data');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const write = (name: string, contents: string) => {
    fs.writeFileSync(path.join(dataDir, name), contents);
  };

  if (options.nameWithOwner !== undefined) {
    write('nameWithOwner', `${options.nameWithOwner}\n`);
  }
  if (options.defaultBranch !== undefined) {
    write('defaultBranch', `${options.defaultBranch}\n`);
  }
  if (options.compare !== undefined) {
    write('compare', options.compare.map(row => row.join('\t')).join('\n') + '\n');
  }
  if (options.prList !== undefined) {
    write(
      'prList',
      typeof options.prList === 'string'
        ? options.prList
        : JSON.stringify(options.prList),
    );
  }

  // `cat` on a file that was never written exits non-zero, which is exactly
  // the "gh could not answer" path the code already handles.
  const script = `#!/bin/sh
case "$*" in
  *"repo view"*defaultBranchRef*) exec cat ${JSON.stringify(path.join(dataDir, 'defaultBranch'))} ;;
  *"repo view"*) exec cat ${JSON.stringify(path.join(dataDir, 'nameWithOwner'))} ;;
  *"pr list"*) exec cat ${JSON.stringify(path.join(dataDir, 'prList'))} ;;
  *api*compare*) exec cat ${JSON.stringify(path.join(dataDir, 'compare'))} ;;
esac
echo "fake gh: unhandled invocation: $*" >&2
exit 1
`;
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(ghPath, script);
  fs.chmodSync(ghPath, 0o755);

  originalPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}${path.delimiter}${originalPath ?? ''}`;
}

export function restore(): void {
  if (originalPath === undefined) return;
  process.env['PATH'] = originalPath;
  originalPath = undefined;
}
