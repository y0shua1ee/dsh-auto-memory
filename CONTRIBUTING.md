# Contributing

1. Use Node 22 or newer and pnpm.
2. Install and build, then run the pure tests:

   ```bash
   pnpm install
   pnpm build
   node --test test/store.test.mjs test/memory-frontmatter.test.mjs test/render-paths.test.mjs test/rules.test.mjs test/index-budget.test.mjs test/modified.test.mjs
   ```

   Source lives in `src/*.ts`; edit it and rebuild rather than editing `lib/*.js` by hand.

3. For integration tests, extract a packaged DSH runtime first:

   ```bash
   node scripts/extract-runtime.mjs
   DSH_APP_NODE_MODULES=/tmp/dsh-app/dsh/node_modules \
     node --import ./test/register.mjs --test test/plugin.test.mjs test/rules-plugin.test.mjs test/worktree-plugin.test.mjs
   ```

4. Keep changes focused, add tests for behavior changes, and avoid committing credentials, local session data, or machine-specific absolute paths.
5. Commit messages use English Conventional Commits, for example `feat(rules): load path-scoped user rules`.
