#!/usr/bin/env node
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
    npx release-with-ease           # Normal release
    npx release-with-ease --dry-run # Preview what would be done
*/

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');

const readmePath = path.join(process.cwd(), 'README.md');
const packageJsonPath = path.join(process.cwd(), 'package.json');

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function safeRun(cmd, opts = {}) {
  try {
    return { ok: true, out: run(cmd, opts) };
  } catch (err) {
    return { ok: false, err };
  }
}

function fetchOriginTags() {
  const res = safeRun('git fetch origin --tags');
  if (res.ok) return res.out.trim();
  return null;
}

function getLastVersionTag() {
  const res = safeRun(
    'git describe --tags --match "v[0-9]*.[0-9]*.[0-9]*" --abbrev=0',
  );
  if (res.ok) return res.out.trim();
  return null;
}

function getCommitRange(lastTag) {
  if (lastTag) {
    return safeRun(
      `git log ${lastTag}..HEAD --pretty=format:%H%x1f%s%x1f%b%x1e`,
    ).out;
  }
  // No tag yet; use last 100 commits
  return safeRun('git log -n 100 --pretty=format:%H%x1f%s%x1f%b%x1e').out;
}

function parseCommits(raw) {
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      const [hash, subject, body] = chunk.split('\x1f');
      return { hash, subject: subject || '', body: body || '' };
    });
}

function extractPrNumber(subject, body) {
  // "(#123)" suffix — squash-merge style
  const m = subject.match(/\(#(\d+)\)\s*$/);
  if (m) return parseInt(m[1], 10);
  // "Merge pull request #123" — merge commit style
  const mm = subject.match(/Merge pull request #(\d+)/);
  if (mm) return parseInt(mm[1], 10);
  // Same patterns in body
  const bm = (body || '').match(/\(#(\d+)\)\s*$/m);
  if (bm) return parseInt(bm[1], 10);
  return null;
}

function fetchGitHubMeta(commits, lastTag) {
  const repoRes = safeRun('gh repo view --json nameWithOwner -q .nameWithOwner');
  if (!repoRes.ok) return commits;
  const [owner, repo] = repoRes.out.trim().split('/');

  // SHA → GitHub login via compare API (best-effort)
  const shaToLogin = {};
  if (lastTag) {
    const cmpRes = safeRun(
      `gh api "repos/${owner}/${repo}/compare/${lastTag}...HEAD" --jq '.commits[] | [.sha, (.author.login // "")] | @tsv'`,
    );
    if (cmpRes.ok) {
      for (const line of cmpRes.out.trim().split('\n').filter(Boolean)) {
        const [sha, login] = line.split('\t');
        if (sha && login) shaToLogin[sha] = login;
      }
    }
  }

  // Merge commit SHA → PR number via pr list (best-effort)
  const shaToPr = {};
  const prRes = safeRun(
    `gh pr list --state merged --limit 100 --json number,mergeCommit --jq '.[] | select(.mergeCommit != null) | [.mergeCommit.oid, (.number | tostring)] | @tsv'`,
  );
  if (prRes.ok) {
    for (const line of prRes.out.trim().split('\n').filter(Boolean)) {
      const [sha, num] = line.split('\t');
      if (sha && num) shaToPr[sha] = parseInt(num, 10);
    }
  }

  return commits.map(c => ({
    ...c,
    githubLogin: shaToLogin[c.hash] || null,
    prNumber: shaToPr[c.hash] ?? extractPrNumber(c.subject, c.body),
  }));
}

async function askClaudeForRelease(commits, isPublicPackage = false) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const basePrompt =
    'You are a release assistant. Given recent git commits, decide one of: major, minor, or patch following semver. Consider conventional commits, breaking changes, and scope. Also generate concise release notes for a public changelog. Respond with JSON containing "bump" (major/minor/patch), "reasoning" (brief explanation for version bump), and "notes" (array of 3-8 short bullet points of the most important user-facing changes). Use present tense for release notes (e.g. "Add script" not "Added script" or "Adds script"). Do not wrap the JSON in ```json or anything else.';

  const publicExtra = isPublicPackage
    ? ' Each commit may carry metadata in brackets like [by @login in #123]. When present, append that attribution verbatim at the end of the corresponding bullet point.'
    : '';

  const systemPrompt = basePrompt + publicExtra;

  const userContent = commits
    .map(c => {
      const body = c.body ? c.body.trim() : '';
      const truncatedBody = body.length > 500 ? body.slice(0, 500) + '…' : body;
      const meta = [];
      if (c.githubLogin) meta.push(`by @${c.githubLogin}`);
      if (c.prNumber) meta.push(`in #${c.prNumber}`);
      const metaStr = meta.length ? ` [${meta.join(' ')}]` : '';
      return `- ${c.subject}${metaStr}\n${truncatedBody}`;
    })
    .join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    console.error(await res.text());
    throw new Error(
      `Failed to determine version bump: ${res.statusText} ${res.status}`,
    );
  }
  const data = await res.json();
  const raw = (data.content?.[0]?.text || '').trim();
  const content = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  const parsed = JSON.parse(content);
  if (!parsed.bump || !['major', 'minor', 'patch'].includes(parsed.bump)) {
    throw new Error('Invalid bump value in Claude response');
  }
  if (!parsed.reasoning) {
    throw new Error('Missing reasoning in Claude response');
  }
  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error('Missing or invalid notes array in Claude response');
  }

  return {
    bump: parsed.bump,
    reasoning: parsed.reasoning,
    notes: parsed.notes.map(note => `- ${note}`),
  };
}

function bumpVersionString(cur, bump) {
  const [maj, min, pat] = cur.split('.').map(n => parseInt(n, 10));
  if (Number.isNaN(maj) || Number.isNaN(min) || Number.isNaN(pat)) {
    throw new Error(`Invalid version in package.json: ${cur}`);
  }
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function insertChangelogEntry(readmeContent, newReadmeLines) {
  const lines = readmeContent.split('\n');
  const changelogIdx = lines.findIndex(l =>
    /^#\s*Changelog\s*$/i.test(l.trim()),
  );

  if (changelogIdx === -1) {
    throw new Error('Could not find "# Changelog" section in README.md');
  }

  // Find insertion point: after the Changelog heading and any blank line
  let insertAt = changelogIdx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') {
    insertAt += 1;
  }

  // Insert new entry before the current first version subsection
  lines.splice(insertAt, 0, ...newReadmeLines, '');

  return lines.join('\n');
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, ans => {
      rl.close();
      resolve(ans);
    });
  });
}

function hasReadmeChangelog() {
  if (!fs.existsSync(readmePath)) return false;
  const content = fs.readFileSync(readmePath, 'utf8');
  return /^#\s*Changelog\s*$/im.test(content);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  return { dryRun };
}

(async function main() {
  try {
    const { dryRun } = parseArgs();

    // Check for required environment variable early
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY environment variable is required.');
      console.error(
        '   You can get one from https://console.anthropic.com/settings/keys',
      );
      console.error(
        '   Please add it to your .env file: ANTHROPIC_API_KEY=your_key_here',
      );
      process.exit(1);
    }

    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made\n');
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const isPublicPackage = pkg.private !== true && pkg.private !== 'true';
    const privateFieldMissing = isPublicPackage && pkg.private === undefined;

    fetchOriginTags();
    const lastVersionTag = getLastVersionTag();
    const raw = getCommitRange(lastVersionTag);
    let commits = parseCommits(raw);
    if (!commits.length) {
      console.log('No commits found since last tag. Aborting.');
      process.exit(1);
    }

    console.log(
      `\n📊 Analyzing ${commits.length} commits since ${
        lastVersionTag || 'beginning'
      }:`,
    );
    commits.forEach(commit => {
      const shortSha = commit.hash.substring(0, 7);
      console.log(`  ${shortSha} ${commit.subject}`);
    });

    if (isPublicPackage) {
      commits = fetchGitHubMeta(commits, lastVersionTag);
    }

    console.log('\nWaiting for Claude to analyze commits...');

    const result = await askClaudeForRelease(commits, isPublicPackage);

    const { bump, reasoning, notes } = result;

    console.log(`\nSuggested version bump: ${bump}\n`);
    console.log(`Reasoning:\n\n${reasoning}\n`);
    const confirm = (
      await prompt('Proceed with this bump? [Y/n/major/minor/patch] ')
    )
      .trim()
      .toLowerCase();
    let finalBump = bump;
    if (['major', 'minor', 'patch'].includes(confirm)) finalBump = confirm;
    else if (confirm === 'n' || confirm === 'no') {
      console.log('Aborted by user.');
      process.exit(1);
    }

    const curVersion = pkg.version;
    const newVersion = bumpVersionString(curVersion, finalBump);

    console.log(`\n📝 Release notes for ${newVersion}:`);
    notes.forEach(note => console.log(`  ${note}`));

    // Create a temporary file with just the changelog entry
    const randomName = `changelog-entry-${crypto
      .randomBytes(8)
      .toString('hex')}.tmp`;
    const tempEntryPath = path.join(os.tmpdir(), randomName);
    const entryContent = [`## ${newVersion}`, '', ...notes, ''].join('\n');
    fs.writeFileSync(tempEntryPath, entryContent);

    console.log(
      `\n📝 Opening editor to review changelog entry for ${newVersion}...`,
    );
    console.log(
      '   Edit the changelog entry as needed, then save and close the editor.',
    );

    // Open editor with the temporary entry file
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    const editorCmd = `${editor} "${tempEntryPath}"`;

    try {
      run(editorCmd, { stdio: 'inherit' });
    } catch (err) {
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
        console.log(
          `  ${step++}. Insert changelog entry for ${newVersion} into README.md`,
        );
        console.log(`  ${step++}. git add README.md`);
        console.log(
          `  ${step++}. git commit -m "Update changelog for ${newVersion}"`,
        );
      }
      console.log(`  ${step++}. npm version ${finalBump} -m "%s"`);
      console.log(`  ${step++}. git push origin main --tags`);
      console.log(`  ${step++}. gh release create v${newVersion} --title "v${newVersion}" --notes-file <entry>`);
      if (isPublicPackage) {
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
      const readme = fs.readFileSync(readmePath, 'utf8');
      const updatedReadme = insertChangelogEntry(
        readme,
        editedEntry.trim().split('\n'),
      );
      fs.writeFileSync(readmePath, updatedReadme);

      run('git add README.md');
      run(`git commit -m "Update changelog for ${newVersion}"`);
    }

    fs.unlinkSync(tempEntryPath);

    // Use npm version keyword per user preference
    run(`npm version ${finalBump} -m "%s"`);

    // Push commit and tags explicitly
    run('git push origin main --tags');

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
          console.log('Aborted. Set "private": false in package.json to suppress this prompt.');
          process.exit(1);
        }
      }
      const publishResult = safeRun('npm publish');
      if (!publishResult.ok) {
        const stderr = publishResult.err?.stderr?.toString() || '';
        if (/one-time password|otp|2fa|e401|e403|eneedauth|forbidden|unauthorized/i.test(stderr)) {
          console.log('\n🔐 npm requires authentication to publish. Running npm login...');
          run('npm login', { stdio: 'inherit' });
          run('npm publish', { stdio: 'inherit' });
        } else {
          throw publishResult.err;
        }
      }
      console.log(`\n📦 Published ${pkg.name}@${newVersion} to npm.`);
    }

    console.log(`\nRelease ${newVersion} created and pushed with tags.`);
  } catch (err) {
    console.error(err?.stderr?.toString?.() || err?.message || err);
    process.exit(1);
  }
})();
