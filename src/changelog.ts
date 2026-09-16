import fs from 'node:fs';
import path from 'node:path';

// Resolved on each call rather than at import time: the script runs against
// whatever directory it was invoked from, and tests chdir between cases.
export function readmePath(): string {
  return path.join(process.cwd(), 'README.md');
}

export function packageJsonPath(): string {
  return path.join(process.cwd(), 'package.json');
}

export function hasReadmeChangelog(): boolean {
  const file = readmePath();
  if (!fs.existsSync(file)) return false;
  return /^#\s*Changelog\s*$/im.test(fs.readFileSync(file, 'utf8'));
}

export function insertChangelogEntry(
  readmeContent: string,
  newReadmeLines: ReadonlyArray<string>,
): string {
  const lines = readmeContent.split('\n');
  const changelogIdx = lines.findIndex(l => /^#\s*Changelog\s*$/i.test(l.trim()));

  if (changelogIdx === -1) {
    throw new Error('Could not find "# Changelog" section in README.md');
  }

  // Find insertion point: after the Changelog heading and any blank line
  let insertAt = changelogIdx + 1;
  while (insertAt < lines.length && lines[insertAt]?.trim() === '') {
    insertAt += 1;
  }

  // Insert new entry before the current first version subsection
  lines.splice(insertAt, 0, ...newReadmeLines, '');

  return lines.join('\n');
}
