# Contributing

1. Use Node 22 or newer and pnpm.
2. Install, type-check, build, and run every test:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   ```

   Source lives in `src/*.ts`; edit it and rebuild rather than editing `lib/*.js` by hand. The wiring tests use the installed `@deepseek-ai/*` devDependencies.

3. To test against a packaged DSH runtime instead, extract it once:

   ```bash
   node scripts/extract-runtime.mjs
   DSH_APP_NODE_MODULES=/tmp/dsh-app/dsh/node_modules \
     node --import ./test/register.mjs --test test/plugin.test.mjs test/rules-plugin.test.mjs test/worktree-plugin.test.mjs
   ```

4. Keep changes focused, add tests for behavior changes, and avoid committing credentials, local session data, or machine-specific absolute paths.
5. Commit messages use English Conventional Commits, for example `feat(rules): load path-scoped user rules`.
