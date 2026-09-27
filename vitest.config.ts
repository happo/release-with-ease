import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the repo's own tests. Vitest's default include is every
    // `*.test.*` under the root, which would also pick up the copies in
    // gitignored checkouts such as `.claude/worktrees/`.
    include: ['src/**/*.test.ts'],
  },
});
