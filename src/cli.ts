/*
  Release helper script

  - Analyzes git history and suggests semver bump (major/minor/patch) using Claude
  - Prompts for confirmation or choice override
  - Generates concise release notes using Claude
  - Inserts a new entry at the top of the Changelog in README.md
  - Commits changelog update, bumps version via npm, and pushes with tags

  Requirements:
    - ANTHROPIC_API_KEY environment variable must be set

  Usage:
    npx release-with-ease            # Normal release
    npx release-with-ease --dry-run  # Preview what would be done
    npx release-with-ease --path .   # Only analyze commits touching a path
*/

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configuredPaths,
  parseArgs,
  UsageError,
  unscopedSubdirectoryWarning,
  type PackageJson,
} from './args.ts';
import { askClaudeForRelease } from './claude.ts';
import {
  hasReadmeChangelog,
  insertChangelogEntry,
  packageJsonPath,
  readmePath,
} from './changelog.ts';
import { run, safeRun } from './exec.ts';
import {
  fetchOriginTags,
  getCommitRange,
  getLastVersionTag,
  parseCommits,
  preflightChecks,
} from './git.ts';
import { fetchGitHubMeta, type CommitWithMeta } from './github.ts';
import { fetchNpmOtp } from './npm.ts';
import { prompt } from './prompt.ts';
import { bumpVersionString, isBump, type Bump } from './version.ts';

/**
 * One line per entry, as it will be handed to Claude. Squash-merge subjects
 * already end in "(#123)", so the number is only appended where it adds
 * something.
 */
export function formatCommitLine(commit: CommitWithMeta): string {
  const shortSha = commit.hash.substring(0, 7);
  const pr =
    commit.prNumber && !commit.subject.includes(`#${commit.prNumber}`)
      ? ` (#${commit.prNumber})`
      : '';
  return `  ${shortSha} ${commit.subject}${pr}`;
}

export async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { dryRun, paths: pathArgs } = parseArgs(argv);

  // Check for required environment variable early
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required.');
    console.error('   You can get one from https://console.anthropic.com/settings/keys');
    console.error('   Please add it to your .env file: ANTHROPIC_API_KEY=your_key_here');
    process.exit(1);
  }

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath(), 'utf8')) as PackageJson;
  const isPublicPackage = pkg.private !== true && pkg.private !== 'true';
  const privateFieldMissing = isPublicPackage && pkg.private === undefined;
  const paths = pathArgs.length ? pathArgs : configuredPaths(pkg);

  fetchOriginTags();
  const { defaultBranch } = preflightChecks();
  const lastVersionTag = getLastVersionTag();

  const warning = unscopedSubdirectoryWarning(paths, pkg);
  if (warning) console.log(warning);

  const raw = getCommitRange(lastVersionTag, paths);
  let commits: Array<CommitWithMeta> = parseCommits(raw).map(c => ({
    ...c,
    githubLogin: null,
    prNumber: null,
  }));
  if (!commits.length) {
    // With a pathspec this is the ordinary "nothing to release here yet"
    // outcome rather than a broken repository, so name what was looked at.
    console.log(
      `No commits found since ${lastVersionTag || 'the start of history'}${
        paths.length ? ` touching ${paths.join(', ')}` : ''
      }. Aborting.`,
    );
    process.exit(1);
  }

  // Resolve pull requests before printing the list: a stack merged as one
  // commit turns into one entry per pull request here, and the printed list
  // is the only chance to notice that before the release notes are written.
  if (isPublicPackage) {
    commits = fetchGitHubMeta(commits, lastVersionTag, paths);
  }

  console.log(
    `\n📊 Analyzing ${commits.length} change${
      commits.length === 1 ? '' : 's'
    } since ${lastVersionTag || 'beginning'}${
      paths.length ? ` (limited to ${paths.join(', ')})` : ''
    }:`,
  );
  commits.forEach(commit => console.log(formatCommitLine(commit)));

  console.log('\nWaiting for Claude to analyze commits...');

  const result = await askClaudeForRelease(commits, isPublicPackage);
  if (!result) {
    throw new Error('Claude did not return a release suggestion.');
  }

  const { bump, reasoning, notes } = result;

  console.log(`\nSuggested version bump: ${bump}\n`);
  console.log(`Reasoning:\n\n${reasoning}\n`);
  const confirm = (await prompt('Proceed with this bump? [Y/n/major/minor/patch] '))
    .trim()
    .toLowerCase();
  let finalBump: Bump = bump;
  if (isBump(confirm)) finalBump = confirm;
  else if (confirm === 'n' || confirm === 'no') {
    console.log('Aborted by user.');
    process.exit(1);
  }

  const curVersion = pkg.version;
  if (!curVersion) {
    throw new Error('package.json has no "version" field.');
  }
  const newVersion = bumpVersionString(curVersion, finalBump);

  console.log(`\n📝 Release notes for ${newVersion}:`);
  notes.forEach(note => console.log(`  ${note}`));

  // Create a temporary file with just the changelog entry
  const randomName = `changelog-entry-${crypto.randomBytes(8).toString('hex')}.tmp`;
  const tempEntryPath = path.join(os.tmpdir(), randomName);
  const entryContent = [`## ${newVersion}`, '', ...notes, ''].join('\n');
  fs.writeFileSync(tempEntryPath, entryContent);

  console.log(`\n📝 Opening editor to review changelog entry for ${newVersion}...`);
  console.log('   Edit the changelog entry as needed, then save and close the editor.');

  // Open editor with the temporary entry file
  const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'nano';
  const editorCmd = `${editor} "${tempEntryPath}"`;

  try {
    run(editorCmd, { stdio: 'inherit' });
  } catch {
    console.error(
      '❌ Failed to open editor. Please set EDITOR or VISUAL environment variable.',
    );
    fs.unlinkSync(tempEntryPath);
    process.exit(1);
  }

  // Check if user saved the file (file should still exist)
  if (!fs.existsSync(tempEntryPath)) {
    console.log('❌ Editor was closed without saving. Aborting release.');
    process.exit(1);
  }

  const useReadmeChangelog = hasReadmeChangelog();

  if (dryRun) {
    console.log(`\n🔍 DRY RUN - Would have done the following:`);
    let step = 1;
    if (useReadmeChangelog) {
      console.log(`  ${step++}. Insert changelog entry for ${newVersion} into README.md`);
      console.log(`  ${step++}. git add README.md`);
      console.log(`  ${step++}. git commit -m "Update changelog for ${newVersion}"`);
    }
    console.log(`  ${step++}. npm version ${finalBump} -m "%s"`);
    console.log(`  ${step++}. git push origin ${defaultBranch} --tags`);
    console.log(
      `  ${step++}. gh release create v${newVersion} --title "v${newVersion}" --notes-file <entry>`,
    );
    if (isPublicPackage) {
      console.log(`  ${step++}. npm whoami (run npm login if not authenticated)`);
      console.log(`  ${step++}. npm publish`);
      if (privateFieldMissing) {
        console.log(
          `\n⚠️  Warning: package.json has no "private" field. The package will be published to npm.\n` +
            `   Set "private": true to prevent publishing, or "private": false to suppress this warning.`,
        );
      }
    }
    console.log(`\n✅ Dry run complete. Use without --dry-run to execute.`);
    fs.unlinkSync(tempEntryPath);
    return;
  }

  // Read the edited entry
  const editedEntry = fs.readFileSync(tempEntryPath, 'utf8');

  if (useReadmeChangelog) {
    // Insert changelog entry into README.md
    const readme = fs.readFileSync(readmePath(), 'utf8');
    const updatedReadme = insertChangelogEntry(readme, editedEntry.trim().split('\n'));
    fs.writeFileSync(readmePath(), updatedReadme);

    run('git add README.md');
    run(`git commit -m "Update changelog for ${newVersion}"`);
  }

  fs.unlinkSync(tempEntryPath);

  // Use npm version keyword per user preference
  run(`npm version ${finalBump} -m "%s"`);

  // Push commit and tags explicitly
  run(`git push origin ${defaultBranch} --tags`);

  // Create GitHub release
  const ghNotesFile = path.join(
    os.tmpdir(),
    `release-notes-${crypto.randomBytes(8).toString('hex')}.md`,
  );
  fs.writeFileSync(ghNotesFile, editedEntry.trim());
  try {
    const releaseUrl = run(
      `gh release create v${newVersion} --title "v${newVersion}" --notes-file "${ghNotesFile}"`,
    ).trim();
    console.log(`\n🎉 GitHub release created: ${releaseUrl}`);
  } finally {
    fs.unlinkSync(ghNotesFile);
  }

  if (isPublicPackage) {
    if (privateFieldMissing) {
      console.log(
        `\n⚠️  Warning: package.json has no "private" field. About to publish ${pkg.name} to npm.`,
      );
      const answer = (await prompt('   Confirm publish? [y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log(
          'Aborted. Set "private": false in package.json to suppress this prompt.',
        );
        process.exit(1);
      }
    }
    const whoami = safeRun('npm whoami');
    if (!whoami.ok) {
      console.log('\n🔐 Not logged in to npm. Opening browser for npm login...');
      const loginResult = safeRun('npm login', { stdio: 'inherit' });
      if (!loginResult.ok) {
        throw loginResult.err;
      }
    }

    const otp = fetchNpmOtp();
    const publishCmd = otp ? `npm publish --otp=${otp}` : 'npm publish';
    const publishResult = safeRun(publishCmd, { stdio: 'inherit' });
    if (!publishResult.ok) {
      throw publishResult.err;
    }
    console.log(`\n📦 Published ${pkg.name}@${newVersion} to npm.`);
  }

  console.log(`\nRelease ${newVersion} created and pushed with tags.`);
}

export async function cli(argv: ReadonlyArray<string>): Promise<void> {
  try {
    await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    const e = err as { stderr?: { toString?: () => string }; message?: string };
    console.error(e?.stderr?.toString?.() || e?.message || err);
    process.exit(1);
  }
}
