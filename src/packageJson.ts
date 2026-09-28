import fs from 'node:fs';
import path from 'node:path';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

/**
 * Rewrites a JSON file through `update`, keeping the indentation, line
 * endings and trailing newline it already had, so that the diff is the
 * changed value and nothing else.
 */
function rewriteJson(file: string, update: (data: Record<string, unknown>) => void): void {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  update(data);

  const multiline = /\n/.test(raw.trim());
  const indent = multiline ? (raw.match(/^[{[][ \t]*\r?\n([ \t]+)/)?.[1] ?? '  ') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(data, null, indent);
  // Newlines inside string values are escaped by JSON.stringify, so every
  // literal one left in the output is formatting.
  if (eol !== '\n') out = out.replaceAll('\n', eol);
  if (/\n$/.test(raw)) out += eol;
  fs.writeFileSync(file, out);
}

/**
 * The npm lockfile of the workspace `dir` belongs to, found by walking up to
 * the repository root, or null. Only a lockfile that lists `dir` as one of
 * its packages counts.
 */
function workspaceLockfile(dir: string): { file: string; key: string } | null {
  const packageDir = path.resolve(dir);
  // A package at the repository root is the workspace root itself.
  if (fs.existsSync(path.join(packageDir, '.git'))) return null;
  let current = path.dirname(packageDir);
  for (;;) {
    for (const lockfile of LOCKFILES) {
      const file = path.join(current, lockfile);
      if (!fs.existsSync(file)) continue;
      // Lockfile keys use forward slashes whatever the platform.
      const key = path.relative(current, packageDir).split(path.sep).join('/');
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          packages?: Record<string, unknown>;
        };
        if (data.packages?.[key]) return { file, key };
      } catch {
        // Not ours to fix; the release goes ahead without it.
      }
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current || fs.existsSync(path.join(current, '.git'))) return null;
    current = parent;
  }
}

/**
 * Sets `version` in the package.json in `dir`, and in an npm lockfile beside
 * it if there is one — or, for a package in an npm workspace, in the
 * workspace's lockfile at the root. Returns the files it changed, relative to
 * `dir`.
 *
 * This is the part of `npm version` the release needs, done directly. The
 * script already committed and tagged by itself (`npm version` can only make
 * `v`-prefixed tags, and only finds git when `.git` is in its own directory),
 * so all that was left for npm was this edit — and with it, running npm in
 * repositories that may not use npm at all. Its
 * `preversion`/`version`/`postversion` scripts are therefore not run.
 */
export function writeVersion(dir: string, version: string): Array<string> {
  rewriteJson(path.join(dir, 'package.json'), (data) => {
    data['version'] = version;
  });
  const changed = ['package.json'];

  for (const lockfile of LOCKFILES) {
    const file = path.join(dir, lockfile);
    if (!fs.existsSync(file)) continue;
    rewriteJson(file, (data) => {
      data['version'] = version;
      // lockfileVersion 2 and 3 repeat the root package's version here.
      const root = (data['packages'] as Record<string, Record<string, unknown>> | undefined)?.[''];
      if (root) root['version'] = version;
    });
    changed.push(lockfile);
  }

  if (changed.length === 1) {
    const workspace = workspaceLockfile(dir);
    if (workspace) {
      rewriteJson(workspace.file, (data) => {
        const entry = (data['packages'] as Record<string, Record<string, unknown>>)[workspace.key];
        if (entry) entry['version'] = version;
      });
      changed.push(path.relative(dir, workspace.file));
    }
  }

  return changed;
}
