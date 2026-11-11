import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../lib/paths.js";

const APP_NODE_MODULES =
  process.env.DSH_APP_NODE_MODULES ?? "/tmp/dsh-app/dsh/node_modules";
const LOCAL_FRAMEWORK = new URL("../node_modules/@deepseek-ai/dsh-llm", import.meta.url);
const FRAMEWORK_AVAILABLE =
  existsSync(join(APP_NODE_MODULES, "@deepseek-ai/dsh-llm")) || existsSync(LOCAL_FRAMEWORK);

function fakeInbox() {
  return {
    nextStep: [],
    prepend(_queue, message) {
      this.nextStep.unshift(message);
    },
    replace(id, message) {
      const index = this.nextStep.findIndex((candidate) => candidate.id === id);
      if (index >= 0) this.nextStep[index] = message;
    },
    remove(id) {
      this.nextStep = this.nextStep.filter((candidate) => candidate.id !== id);
    }
  };
}

function fakeAgent(cwd) {
  return {
    session: {
      header: { cwd, delegationDepth: 0 },
      surface: { nodes: [] },
      eventAt() {
        return undefined;
      }
    },
    inbox: fakeInbox()
  };
}

test("worktree sessions share memory but keep project rules anchored to the worktree", { skip: !FRAMEWORK_AVAILABLE }, async () => {
  const plugin = await import("../lib/index.js");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const base = await mkdtemp(join(tmpdir(), "dsh-auto-memory-worktree-plugin-"));
  const repo = join(base, "repo");
  const worktree = join(repo, "wt");
  const cwd = join(worktree, "src");
  await mkdir(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  await mkdir(join(worktree, ".claude", "rules"), { recursive: true });
  await writeFile(
    join(worktree, ".claude", "rules", "ts.md"),
    "---\npaths:\n  - \"src/**/*.ts\"\n---\n# TypeScript\n\nUse strict types.\n"
  );

  const memoryRoot = join(base, "memory");
  const memoryDir = join(memoryRoot, projectKey(repo));
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "MEMORY.md"), "# Project memory\n\n- [Notes](notes.md) — test note.\n");
  await writeFile(join(memoryDir, "notes.md"), "# Notes\n");

  const handlers = new Map();
  const runPreStep = async (payload, next) => {
    const chain = handlers.get("agent/pre-step") ?? [];
    let index = 0;
    const dispatch = async (current) => {
      if (index >= chain.length) return next();
      const listener = chain[index];
      index += 1;
      return listener(current, () => dispatch(current));
    };
    return dispatch(payload);
  };
  const ctx = {
    systemPrompt: { section() {}, getSectionOrder() { return 2400; } },
    tools: { register() {} },
    on(event, handler) {
      const chain = handlers.get(event) ?? [];
      chain.push(handler);
      handlers.set(event, chain);
    },
    workingDirectory: { async ensure() { return cwd; } },
    logger: { warn() {} }
  };

  plugin.apply(ctx, {
    root: memoryRoot,
    userRuleDirs: [],
    projectRuleDirs: [".claude/rules"],
    guidance: false
  });

  const agent = fakeAgent(cwd);
  const user = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
  const first = await runPreStep(
    { agent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(first.messages.filter((message) => message.source.kind === "auto-memory").length, 1);
  assert.equal(first.messages.filter((message) => message.source.kind === "auto-rules").length, 0);

  for (const handler of handlers.get("tools/result") ?? []) {
    handler(
      { name: "read", arguments: { file_path: "src/a.ts" }, agent, signal: new AbortController().signal },
      { isError: false }
    );
  }

  const second = await runPreStep(
    { agent, messages: first.messages, step: 2, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...first.messages, user] })
  );
  const rules = second.messages.filter((message) => message.source.kind === "auto-rules");
  assert.equal(rules.length, 1);
  assert.match(rules[0].content[0].text, /Use strict types/);
});
