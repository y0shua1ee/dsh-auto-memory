# dsh-auto-memory — agent notes

File-based persistent project memory for DeepSeek Harness (DSH). This repo is a DSH **bundle plugin**: a profile selects `@y0shua1ee/dsh-auto-memory` in `dsh.profile.bundles`, the package's `cordis.patch.yml` mounts the row, and framework packages stay peers.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | plugin entry: `name`, `inject`, `Config`, `apply`; registers tool, prompt section, pre-step listener |
| `lib/config.js` | Schemastery `Config`, direct-apply normalization, `$DSH_HOME` root resolution |
| `lib/paths.js` | DSH-compatible `projectKey`, `.git` root discovery, path display |
| `lib/store.js` | virtual `/memories` filesystem, atomic writes, limits, symlink/traversal guards, index maintenance |
| `lib/memory-frontmatter.js` | memory-file frontmatter parser (`name`, `description`, `metadata.type`) and non-blocking checks |
| `lib/render.js` | bounded `MEMORY.md` snapshot, escaping, SHA-256 digest |
| `lib/guidance.js` | system-prompt guidance |
| `lib/tool.js` | `memory` tool options (no `defineTool` import, so command semantics are testable) |
| `lib/rule-frontmatter.js` | `paths:` frontmatter parser |
| `lib/rule-glob.js` | `*` / `**` / `?` / brace / class glob matcher |
| `lib/rules.js` | rule discovery, caching, budgets, rendering (pure; no DSH imports) |
| `lib/rules-inject.js` | `agent/pre-step` rule injection and `tools/result` file-touch tracking |
| `cordis.patch.yml` | bundle patch that mounts the `dsh-auto-memory` row |
| `assets/icon.svg` | Plugins-page icon |
| `test/` | pure tests plus a loader-based integration test |

## Commands

Use Node 22 or newer. The packaged desktop app ships its own Node under its runtime directory if the shell has none.

```bash
# pure logic
node --test test/store.test.mjs test/render-paths.test.mjs test/rules.test.mjs

# extract the packaged runtime once (writes /tmp/dsh-app by default)
node scripts/extract-runtime.mjs

# plugin wiring, injection, tool execution, rules
DSH_APP_NODE_MODULES=/tmp/dsh-app/dsh/node_modules \
  node --import ./test/register.mjs --test test/plugin.test.mjs test/rules-plugin.test.mjs
```

The integration loader maps `@deepseek-ai/*` to the packaged app because this directory has no `node_modules` and the plugin declares peers only.

## DSH interfaces used (0.2.1-rc.3)

- `ctx.tools.register(defineTool({...}))` — `@deepseek-ai/dsh-tools`
- `ctx.systemPrompt.section({name, order, text})`, `getSectionOrder("TOOL_GOAL")`
- `ctx.on("agent/pre-step", async (payload, next) => ...)`, returning a replacement `{kind: "enter", messages}`
- `ctx.workingDirectory.ensure(agent, signal)`
- `agent.inbox.prepend/replace/remove`, `agent.session.surface.nodes`, `agent.session.eventAt(seq)`
- `ctx.on("tools/result", (exec, result) => ...)` for `read` / `write` / `edit` file touches
- `createUserMessage`, `HarnessError` — `@deepseek-ai/dsh-llm`

## Invariants

- Memory lives **outside** the workspace, under the configured `$DSH_HOME` root; all paths are resolved and confined to it.
- Never follow symlinks inside the memory root; reject traversal, hidden segments, non-`.md` files, and binary content.
- Writes are same-directory temp + `rename`, mode `0600`; mutations serialize per project store.
- Injection is a user-role `<system-reminder>` with a rendered-snapshot digest in `source`; never inject twice for one digest, and re-inject after compaction when the digest is no longer on the surface.
- `MEMORY.md` is the only automatically injected file; topic files are read on demand through the tool.
- Subagents get the tool but not the injection by default (`injectInSubagents`).
- Rules: user roots are trusted and may be symlinks (Nix/Home Manager); project roots are repository input, and symlinks resolving outside the project are skipped. Rule bodies are escaped and framed as context.
- Rules with `paths` stay out of context until `read` / `write` / `edit` touches a match; unconditional rules inject at the first step.

## Gotchas

- `maxFiles` counts `MEMORY.md` too.
- `create` auto-creates `MEMORY.md` when a topic file is the first memory.
- Memory files follow Claude Code's format (one fact per file, `name` / `description` / `metadata.type` frontmatter, `[[name]]` → `/memories/<name>.md`). Frontmatter is advisory: `create` never refuses a file for it, it only lists problems in the tool output. New index lines take `name` and `description`, falling back to the file name and first body line. `str_replace` / `insert` on a topic file refresh its index line's title and hook only where they still equal the old generated values; hand-written parts are kept.
- `str_replace` requires exactly one occurrence; `insert` is 0-based and clamps to the line count.
- Rules are re-discovered every pre-step with an mtime/size cache; a changed rule re-injects with a new digest.
- The desktop app's `$DSH_HOME/profiles/desktop` installs `@y0shua1ee/dsh-auto-memory` from npm, so repo changes reach it only after a publish and an update of that profile; **code changes need an app restart**, config changes can hot-reload.
- The bundle patch entry id is `dsh-auto-memory`; the package/row name is `@y0shua1ee/dsh-auto-memory`. Profile overrides address the id `dsh-auto-memory`, not the old row id `auto-memory`.
