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
  if (eol !== '\n') out = out.replace(/\n/g, eol);
  if (/\n$/.test(raw)) out += eol;
  fs.writeFileSync(file, out);
}

/**
 * Sets `version` in the package.json in `dir`, and in an npm lockfile beside
 * it if there is one. Returns the files it changed, relative to `dir`.
 *
 * This is the part of `npm version` the release needs, done directly. The
 * script already committed and tagged by itself (`npm version` can only make
 * `v`-prefixed tags, and only finds git when `.git` is in its own directory),
 * so all that was left for npm was this edit — and with it, running npm in
 * repositories that may not use npm at all. Its
 * `preversion`/`version`/`postversion` scripts are therefore not run.
 */
export function writeVersion(dir: string, version: string): Array<string> {
  rewriteJson(path.join(dir, 'package.json'), data => {
    data['version'] = version;
  });
  const changed = ['package.json'];

  for (const lockfile of LOCKFILES) {
    const file = path.join(dir, lockfile);
    if (!fs.existsSync(file)) continue;
    rewriteJson(file, data => {
      data['version'] = version;
      // lockfileVersion 2 and 3 repeat the root package's version here.
      const root = (data['packages'] as Record<string, Record<string, unknown>> | undefined)?.[
        ''
      ];
      if (root) root['version'] = version;
    });
    changed.push(lockfile);
  }

  return changed;
}
