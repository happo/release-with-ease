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

# Prerequisites

The script requires these environment variables to be set:

- `ANTHROPIC_API_KEY`

You can get a key from https://console.anthropic.com/settings/keys.

The script also requires the `gh` CLI to be installed and authenticated (used to
create GitHub releases).

If your `README.md` has a `# Changelog` section, the script will automatically
insert the release notes there. Otherwise it skips that step and relies solely on
the GitHub release.

# Changelog

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
