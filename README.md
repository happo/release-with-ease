# release-with-ease

A script that helps you bump the version of an npm library and update release
notes. Uses OpenAI to analyze commits.

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

- `OPEN_AI_API_KEY`

You can get a key from https://platform.openai.com/api-keys.

The script also assumes that your README.md file has a `# Changelog` section.

# Changelog

## 1.0.0

- Initial release
