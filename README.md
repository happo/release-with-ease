# release-with-ease

A script that helps you bump the version of an npm library and update release
notes. Uses Claude to analyze commits.

# Usage

Run the script provided with the library:

```sh
npx release-with-ease
```

If you just want to preview the changes that would be made, use the `--dry-run` flag:

```sh
npx release-with-ease --dry-run
```

The script reads `package.json` and `README.md` from the current directory, so
run it from the package you want to release — or name the package, and it
finds it (see [Monorepos](#monorepos)):

```sh
npx release-with-ease my-package
```

A release:

1. inserts the release notes into the `# Changelog` section of `README.md`, if
   there is one, and commits that;
2. sets `"version"` in `package.json` (and in `package-lock.json` or
   `npm-shrinkwrap.json`, if there is one next to it), commits it and tags the
   commit;
3. pushes the branch and that tag;
4. creates a GitHub release for the tag;
5. publishes to npm, unless the package is private.

The version is written to `package.json` directly rather than through
`npm version`, so `preversion`, `version` and `postversion` scripts are not run.

# How commits become release notes

The script walks the mainline with `git log --first-parent`, so each merged
pull request contributes one entry rather than every commit it accumulated
along the way. For public packages it then asks `gh` which pull request each
mainline commit came from and uses that pull request's title, description and
author, which reads better than `Merge pull request #123 from owner/branch`.

GitHub merges a **stacked pull request** as a single commit on the mainline,
and every pull request in the stack reports that same commit as its merge
commit. The script expands such a commit back into one entry per pull request,
bottom of the stack first, so the ones underneath the top get described instead
of disappearing into their neighbour's merge commit. With `--path` set, each
pull request in the stack is matched against the pathspec on its own, so a
stack that spans several packages only shows up where it belongs.

The order comes from the branch each pull request was based on, but only after
git confirms the commits line up that way and that all of them are part of the
merge. Branch names can be reused, and a branch can be pushed to after it
merged, so where the claim doesn't check out the entries fall back to the order
they were opened in and the pathspec is applied to the stack as a whole. That
can leave a bullet point too many, which is easy to delete in the editor step —
unlike a pull request credited with files it never touched.

The list of entries is printed before anything is sent to Claude — worth a
glance, since it is what the release notes are written from.

Claude is asked for notes that cover every user-facing change, however many
bullet points that takes, sorted by their impact on users. Each bullet point
names the entries it describes, so when the editor opens, comments below the
entry list every entry no bullet point covers, with Claude's reason for leaving
it out. Each of those lines starts with `//`, like `#` in a git commit message,
and every line that does is dropped when the editor closes, so there is nothing
to clean up — and turning one into a bullet point is a matter of editing that
line. The list is worked out from which entries the notes cite, not from what
Claude says it left out, so an entry it drops without saying so is listed too.

# Monorepos

By default the release notes are written from every commit on the mainline
since the last `v*` tag — the whole repository. In a monorepo that means a
release of one package is described using changes to all the others, and
nothing about the result looks wrong afterwards.

Pass `--path` to limit the commits to the ones that touched a path. It takes a
git pathspec, interpreted relative to the current directory (the package's own,
when a package is named), and can be repeated:

```sh
cd packages/cli
npx release-with-ease --path .

# or, releasing the package at the repository root
npx release-with-ease --path packages/cli --path packages/shared
```

Since a package wants the same pathspec on every release, it is usually better
to put it in the `package.json` being released:

```json
{
  "name": "my-cli",
  "release-with-ease": { "paths": ["."] }
}
```

A `--path` flag on the command line overrides the configured paths. The script
warns when it is releasing a package from a subdirectory with no paths set at
all, since that is nearly always an oversight rather than a choice.

## Tag prefixes

Tags are `vX.Y.Z` by default, which is one series of versions for the whole
repository. For more than one package to release from the same repository,
each needs a series of its own. Set `tagPrefix`, conventionally to the
package's name and an `@`:

```json
{
  "name": "my-cli",
  "release-with-ease": { "paths": ["."], "tagPrefix": "my-cli@" }
}
```

The package's last release is then the most recent `my-cli@X.Y.Z` tag, the next
one is tagged `my-cli@X.Y.Z`, and its GitHub release is titled `my-cli X.Y.Z`.
Commit messages use the whole tag (`Update changelog for my-cli@1.3.0`,
`my-cli@1.3.0`), since a bare version does not say which package it was. Only
the new tag is pushed, not every tag that happens to exist locally.

Switching an existing package over needs no new tag by hand: when there is no
`my-cli@` tag yet, the `v` tag for the current version in `package.json` (say
`v1.2.0`) is where the release notes start from, and the release after it is
`my-cli@1.3.0`.

A prefix has to make a valid git tag once a version is appended, so `:`,
spaces and glob characters are refused.

## Releasing from the repository root

Name the package to release, and the script runs in that package's directory
as if it had been started there:

```sh
npx release-with-ease my-cli
npx release-with-ease packages/cli   # a directory works too
```

A name is looked up among the `package.json` files git tracks, so it works with
any workspace layout. Everything else — `package.json`, `README.md`, `--path`,
the configured paths — is then relative to that package.

A root script makes that `pnpm release <package>`, with the environment
variables from the root `.env`:

```json
{
  "scripts": {
    "release": "set -a && . ./.env && set +a && release-with-ease"
  }
}
```

```sh
pnpm release my-cli
pnpm release my-cli --dry-run
```

# Prerequisites

The script requires these environment variables to be set:

- `ANTHROPIC_API_KEY`

You can get a key from https://console.anthropic.com/settings/keys.

The script also requires the `gh` CLI to be installed and authenticated (used to
create GitHub releases).

If your `README.md` has a `# Changelog` section, the script will automatically
insert the release notes there. Otherwise it skips that step and relies solely on
the GitHub release.

# Publishing to npm

For public packages (i.e. without `"private": true` in `package.json`), the
script publishes to npm after creating the GitHub release.

## Authentication

Before publishing, the script runs `npm whoami` to check whether you're
logged in. If you're not, it runs `npm login`, which opens a browser for
the standard npm web auth flow. After that, `npm publish` runs normally.

## 2FA and one-time passwords (OTP)

For supply-chain security, we recommend keeping your npm account on the
`auth-and-writes` 2FA mode, which requires an OTP for every publish:

```sh
npm profile set 2fa auth-and-writes
```

`auth-and-writes` protects against stolen-token attacks — a leaked
`~/.npmrc` token cannot publish without a live OTP. The alternative
(`auth-only`) skips the publish-time OTP but offers less protection if
your local npm token is ever stolen.

To avoid typing the OTP manually, the script auto-detects a TOTP from
either of these password manager CLIs:

- **1Password**: [`op`](https://developer.1password.com/docs/cli/) — uses
  `op item get <name> --otp`
- **LastPass**: [`lpass`](https://github.com/lastpass/lastpass-cli) — uses
  `lpass show --totp <name>`

For auto-detection to work, name your npm vault entry `npmjs.com` (or
`npm`, or `npmjs` — the script tries each in order) and make sure the
respective CLI is installed and signed in.

If your setup doesn't fit the convention above, set `NPM_OTP_COMMAND` to
any shell command that prints a fresh OTP to stdout:

```sh
# 1Password with a custom item name
export NPM_OTP_COMMAND='op item get "my npm entry" --otp'
# LastPass with a custom item name
export NPM_OTP_COMMAND='lpass show --totp "my npm entry"'
# oathtool, ykman, etc. also work
```

If no OTP source is available, npm's native OTP prompt appears at publish
time and you can type the code by hand.

# Development

The source is TypeScript under `src/`, compiled to `dist/` by `tsc`. The
published `bin/release-with-ease.js` is a shim over the compiled output, so
what `npx` runs is ordinary JavaScript and the `engines` floor holds.

Node and pnpm versions are pinned in `mise.toml`, so
[mise](https://mise.jdx.dev/) will put the right ones on your path:

```sh
mise install
pnpm install
pnpm test    # Vitest, straight from the TypeScript sources
pnpm tsc     # type-check everything, including the tests
pnpm build   # compile src/ to dist/
```

Working on the package needs a newer Node than using it does: the tests run
under Vitest, which wants Node 22.12+ or 24+, while the published JavaScript
only needs what `engines` says. CI checks both.

Tests assert with `node:assert` and mock nothing. Instead, they build real
git repositories in a temporary directory and run
real `git` against them, so the merge shapes under test — a stack landing as
one commit, a branch behind its origin — are the shapes git actually
produces. Where an external command has to be stood in for, it is stood in
for at the lowest level available: `gh` is a real executable placed on `PATH`,
and the Anthropic API is a real HTTP server on localhost reached through
`ANTHROPIC_BASE_URL`.

# Changelog

## 2.8.0

- Implement per-package tag prefixes for monorepo releases, allowing packages to opt in with custom tag prefixes like `server@` [by @lencioni in #29]
- Improve release notes generation to cover all user-facing changes with complete impact-sorted bullet points [by @lencioni in #27]
- Migrate tests from node:test to Vitest for unified test runner across monorepo packages [by @lencioni in #28]
- Update @types/node from 26.5.1 to 26.6.3 [by @app/dependabot in #24, #26]

## 2.7.2

- Prevent release process from failing due to temporary API unavailability [by @Kaushik2210 in #23]

## 2.7.1

- Fix git detection for packages in subdirectories to properly commit and tag version bumps [by @trotzig in #22]
- Update @types/node from 22.20.2 to 26.5.1 [by @app/dependabot in #21]
- Update actions/setup-node from 5.0.0 to 7.0.0 [by @app/dependabot in #20]

## 2.7.0

- Describe every pull request in a merged stack, fixing missing changelog entries when multiple PRs are merged together [by @lencioni in #19]
- Add comprehensive tests for stacked pull request handling
- Add TypeScript support for improved type safety
- Add CI jobs for automated testing and validation
- Add Dependabot configuration for dependency management

## 2.6.0

- Add `--path` flag to limit release notes to a specific pathspec, useful for monorepos [by @trotzig in #18]
- Support `--pathspec` as an alias for `--path`
- Allow repeatable `--path` arguments for multiple pathspecs
- Interpret paths relative to current directory for easier monorepo workflows

## 2.5.0

- Improve release notes generation to use PR merge-commit info instead of individual commits, reducing noise and duplication [by @trotzig in #17]
- Add pnpm lockfile to repository [by @trotzig]

## 2.4.0

- Auto-detect npm OTP from 1Password or LastPass CLI to streamline 2FA releases [by @lencioni in #15]
- Run npm login before publish if not authenticated, supporting browser-based web flow [by @lencioni in #14]
- Verify default branch is checked out before releasing with dynamic branch detection [by @lencioni in #16]
- Refuse to release unless working tree is clean and branch is in sync with origin

## 2.3.4

- Fix npm publish authentication to use native npm prompts instead of manual OTP entry
- Inherit stdio during npm publish to enable 2FA browser challenges and automatic auth handling
- Improve user experience by matching terminal behavior when running npm publish directly [by @lencioni in #11]

## 2.3.3

- Fix npm authentication flow by running login and publish as a single compound command [by @lencioni]

## 2.3.2

- Fix npm publish authentication by running npm login on auth failure [by @lencioni in #10]

## 2.3.1

- Fix npm publish to avoid duplicate OTP prompts when using browser-based authentication [by @lencioni in #8]
- Add CODEOWNERS file to streamline PR review process [by @lencioni in #9]

## 2.3.0

- Add warning and confirmation prompt when publishing packages without an explicit 'private' field in package.json
- Allow users to suppress the prompt by setting 'private': false in package.json
- Skip npm publishing when 'private': true is set [by @trotzig in #7]

## 2.2.0

- Prompt for npm login if not authenticated before publishing
- Improve publishing workflow with better authentication handling [by @trotzig in #6]

## 2.1.0

- Support npm publish and GitHub releases for public npm packages [by @trotzig in #5]
- Include PR number and author attribution in release notes for public packages [by @trotzig]
- Auto-detect README.md changelog section; skip insertion if absent for better compatibility
- Run `npm publish` automatically for packages without `private: true` in package.json
- Create GitHub releases automatically via `gh release create` after every push (for public packages)

## 1.0.1

- Fix path to README and package.json

## 1.0.0

- Initial release
