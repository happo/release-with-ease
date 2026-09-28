# release-with-ease

A CLI (`npx release-with-ease`) that bumps an npm package's version, asks Claude to suggest the semver bump and write release notes from the commits and pull requests since the last tag, inserts those notes into the `# Changelog` section of `README.md`, then commits, tags, pushes, publishes to npm and creates a GitHub release. It is a **public npm package used outside Happo**, so treat the CLI's flags, output and behavior as a public API. `README.md` documents usage for end users.

## Layout

- `src/` — TypeScript sources. `main.ts` is the entry point; `cli.ts` runs the release flow and the other modules are the pieces it calls (`args`, `git`, `github` via the `gh` CLI, `claude` via the Anthropic HTTP API, `npm`, `packageJson`, `changelog`, `tags`, `version`, `workspace`, `exec`, `prompt`).
- `src/__tests__/*.test.ts` — Vitest tests, named after the module they cover, plus `release.test.ts` for the end-to-end flow.
- `src/test-utils/` — test helpers: `tmpfs` (temp directory + chdir), `gitRepo` (real git repos with an `origin`), `fakeGh` (a fake `gh` on `PATH`).
- `bin/release-with-ease.js` — the published shim; it only imports `dist/main.js`.
- `dist/` — compiled output from `pnpm build` (gitignored, published to npm).

## Commands

Run everything through mise (bare `pnpm` is not on `PATH`):

```sh
mise exec -- pnpm install
mise exec -- pnpm test                  # Vitest, straight from the .ts sources
mise exec -- pnpm test src/__tests__/git.test.ts
mise exec -- pnpm tsc                   # type-check src/ including tests
mise exec -- pnpm lint                  # ESLint
mise exec -- pnpm format                # Prettier, over the whole repo
mise exec -- pnpm build                 # compile src/ to dist/
```

## Conventions

- ESM only. Sources import siblings as `./foo.ts`; `tsc` rewrites those to `.js` in `dist/` (`rewriteRelativeImportExtensions`).
- The published JavaScript must run on the `engines.node` floor (`>=20`); CI's `smoke` job runs the built CLI on that version. Developing needs Node 22.12+ or 24 (pinned in `mise.toml`). Don't use runtime APIs newer than Node 20 in `src/` outside tests.
- Tests mock nothing: they build real git repositories in a temp directory, put a real `gh` executable on `PATH`, and point `ANTHROPIC_BASE_URL` at a local HTTP server. Assert with `node:assert`. Keep new tests in that style.
- New tests go in `src/__tests__/<module>.test.ts`; `tsconfig.json` excludes `__tests__` and `test-utils` from the build, and `tsconfig.test.json` type-checks them.
- Releases of this package are made with this package: `pnpm release` runs `bin/release-with-ease.js`, so build first.
