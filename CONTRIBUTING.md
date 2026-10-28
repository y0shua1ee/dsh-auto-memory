# Contributing

1. Use Node 22 or newer.
2. Run the pure tests:

   ```bash
   node --test test/store.test.mjs test/render-paths.test.mjs test/rules.test.mjs
   ```

3. For integration tests, extract a packaged DSH runtime first:

   ```bash
   node scripts/extract-runtime.mjs
   DSH_APP_NODE_MODULES=/tmp/dsh-app/dsh/node_modules \
     node --import ./test/register.mjs --test test/plugin.test.mjs test/rules-plugin.test.mjs
   ```

4. Keep changes focused, add tests for behavior changes, and avoid committing credentials, local session data, or machine-specific absolute paths.
5. Commit messages use English Conventional Commits, for example `feat(rules): load path-scoped user rules`.
