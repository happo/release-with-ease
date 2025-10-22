#!/usr/bin/env node
/*
  Release helper script

  - Analyzes git history and suggests semver bump (major/minor/patch) using OpenAI
  - Prompts for confirmation or choice override
  - Generates concise release notes using OpenAI
  - Inserts a new entry at the top of the Changelog in README.md
  - Commits changelog update, bumps version via npm, and pushes with tags

  Requirements:
    - OPENAI_API_KEY environment variable must be set

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

const repoRoot = path.resolve(__dirname, '..');
const readmePath = path.join(repoRoot, 'README.md');
const packageJsonPath = path.join(repoRoot, 'package.json');

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

async function askOpenAIForRelease(commits) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const messages = [
    {
      role: 'system',
      content:
        'You are a release assistant. Given recent git commits, decide one of: major, minor, or patch following semver. Consider conventional commits, breaking changes, and scope. Also generate concise release notes for a public changelog. Respond with JSON containing "bump" (major/minor/patch), "reasoning" (brief explanation for version bump), and "notes" (array of 3-8 short bullet points of the most important user-facing changes). Use present tense for release notes (e.g. "Add script" not "Added script" or "Adds script"). Do not wrap the JSON in ```json or anything else.',
    },
    {
      role: 'user',
      content: commits
        .map(c => `- ${c.subject}\n${c.body ? c.body.trim() : ''}`)
        .join('\n'),
    },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2,
      max_tokens: 500,
    }),
  });
  if (!res.ok) {
    // throw an actionable error here
    console.error(await res.text());
    throw new Error(
      `Failed to determine version bump: ${res.statusText} ${res.status}`,
    );
  }
  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content || '').trim();

  const parsed = JSON.parse(content);
  if (!parsed.bump || !['major', 'minor', 'patch'].includes(parsed.bump)) {
    throw new Error('Invalid bump value in OpenAI response');
  }
  if (!parsed.reasoning) {
    throw new Error('Missing reasoning in OpenAI response');
  }
  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error('Missing or invalid notes array in OpenAI response');
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

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  return { dryRun };
}

(async function main() {
  try {
    const { dryRun } = parseArgs();

    // Check for required environment variable early
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY environment variable is required.');
      console.error(
        '   You can get one from https://platform.openai.com/api-keys',
      );
      console.error(
        '   Please add it to your .env file: OPENAI_API_KEY=your_key_here',
      );
      process.exit(1);
    }

    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made\n');
    }

    fetchOriginTags();
    const lastVersionTag = getLastVersionTag();
    const raw = getCommitRange(lastVersionTag);
    const commits = parseCommits(raw);
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

    console.log('\nWaiting for OpenAI to analyze commits...');

    const result = await askOpenAIForRelease(commits);

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

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
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

    if (dryRun) {
      console.log(`\n🔍 DRY RUN - Would have done the following:`);
      console.log(
        `  1. Insert changelog entry for ${newVersion} into README.md`,
      );
      console.log(`  2. git add README.md`);
      console.log(`  3. git commit -m "Update changelog for ${newVersion}"`);
      console.log(`  4. npm version ${finalBump} -m "%s"`);
      console.log(`  5. git push origin main --tags`);
      console.log(`\n✅ Dry run complete. Use without --dry-run to execute.`);
      fs.unlinkSync(tempEntryPath);
      return;
    }

    // Read the edited entry and insert it into README
    const editedEntry = fs.readFileSync(tempEntryPath, 'utf8');
    const readme = fs.readFileSync(readmePath, 'utf8');
    const updatedReadme = insertChangelogEntry(
      readme,
      editedEntry.trim().split('\n'),
    );
    fs.writeFileSync(readmePath, updatedReadme);
    fs.unlinkSync(tempEntryPath);

    run('git add README.md');
    run(`git commit -m "Update changelog for ${newVersion}"`);

    // Use npm version keyword per user preference
    run(`npm version ${finalBump} -m "%s"`);

    // Push commit and tags explicitly
    run('git push origin main --tags');

    console.log(`\nRelease ${newVersion} created and pushed with tags.`);
  } catch (err) {
    console.error(err?.stderr?.toString?.() || err?.message || err);
    process.exit(1);
  }
})();
