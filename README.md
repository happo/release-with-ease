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
run it from the package you want to release.

# Monorepos

By default the release notes are written from every commit on the mainline
since the last `v*` tag — the whole repository. In a monorepo that means a
release of one package is described using changes to all the others, and
nothing about the result looks wrong afterwards.

Pass `--path` to limit the commits to the ones that touched a path. It takes a
git pathspec, interpreted relative to the current directory, and can be
repeated:

```sh
cd packages/cli
npx release-with-ease --path .

# or, from anywhere in the repository
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

Two things stay repository-wide, because git tags are:

- The last release is found with `git describe --match "v[0-9]*.[0-9]*.[0-9]*"`,
  and `npm version` creates tags of the same shape. Releasing two packages from
  one repository would have them share a version series.
- The GitHub release created at the end covers the tag, not the path.

So this works well for a monorepo with one publishable package, and needs
per-package tag prefixes — which the script does not support yet — for more
than one.

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

# Changelog

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
