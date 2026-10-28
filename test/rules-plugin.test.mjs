import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../lib/paths.js";

const APP_NODE_MODULES =
  process.env.DSH_APP_NODE_MODULES ?? "/tmp/dsh-app/dsh/node_modules";
const FRAMEWORK_AVAILABLE = existsSync(join(APP_NODE_MODULES, "@deepseek-ai/dsh-llm"));

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

function fakeAgent(cwd, overrides = {}) {
  return {
    session: {
      header: { cwd, delegationDepth: 0 },
      surface: { nodes: [] },
      eventAt() {
        return undefined;
      }
    },
    inbox: fakeInbox(),
    ...overrides
  };
}

test("rules: unconditional, path-scoped, dedupe, updates and subagent skip", { skip: !FRAMEWORK_AVAILABLE }, async () => {
  const plugin = await import("../lib/index.js");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const base = await mkdtemp(join(tmpdir(), "dsh-auto-memory-rules-plugin-"));
  const project = join(base, "repo");
  const cwd = project;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, ".claude", "rules"), { recursive: true });
  const userRules = join(base, "user-rules");
  await mkdir(userRules, { recursive: true });
  await writeFile(join(userRules, "global.md"), "# Global\n\nAlways apply this user rule.\n");
  await writeFile(join(project, ".claude", "rules", "always.md"), "# Always\n\nProject unconditional rule.\n");
  const pathRule = join(project, ".claude", "rules", "ts.md");
  await writeFile(
    pathRule,
    "---\npaths:\n  - \"src/**/*.ts\"\n---\n# TypeScript\n\nUse strict types.\n"
  );
  const memoryRoot = join(base, "memory");
  const memoryDir = join(memoryRoot, projectKey(project));
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
    systemPrompt: {
      section() {},
      getSectionOrder() {
        return 2400;
      }
    },
    tools: { register() {} },
    on(event, handler) {
      const chain = handlers.get(event) ?? [];
      chain.push(handler);
      handlers.set(event, chain);
    },
    workingDirectory: {
      async ensure() {
        return cwd;
      }
    },
    logger: { warn() {} }
  };

  plugin.apply(ctx, {
    root: memoryRoot,
    userRuleDirs: [userRules],
    projectRuleDirs: [".claude/rules"]
  });

  const agent = fakeAgent(cwd);
  const user = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });

  const first = await runPreStep(
    { agent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(first.messages.filter((message) => message.source.kind === "auto-memory").length, 1);
  const firstRules = first.messages.filter((message) => message.source.kind === "auto-rules");
  assert.equal(firstRules.length, 1);
  assert.match(firstRules[0].content[0].text, /Always apply this user rule/);
  assert.match(firstRules[0].content[0].text, /Project unconditional rule/);
  assert.doesNotMatch(firstRules[0].content[0].text, /Use strict types/);
  assert.equal(firstRules[0].source.rules.length, 2);

  const second = await runPreStep(
    { agent, messages: first.messages, step: 2, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...first.messages, user] })
  );
  assert.equal(second.messages.filter((message) => message.source.kind === "auto-rules").length, 1);

  const toolResultHandlers = handlers.get("tools/result") ?? [];
  assert.equal(toolResultHandlers.length, 1);
  for (const handler of toolResultHandlers) {
    handler(
      { name: "read", arguments: { file_path: "src/a.ts" }, agent, signal: new AbortController().signal },
      { isError: false }
    );
  }

  const third = await runPreStep(
    { agent, messages: second.messages, step: 3, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...second.messages, user] })
  );
  const thirdRules = third.messages.filter((message) => message.source.kind === "auto-rules");
  assert.equal(thirdRules.length, 2);
  assert.match(thirdRules[1].content[0].text, /Use strict types/);
  assert.equal(thirdRules[1].source.rules.length, 1);

  const fourth = await runPreStep(
    { agent, messages: third.messages, step: 4, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...third.messages, user] })
  );
  assert.equal(fourth.messages.filter((message) => message.source.kind === "auto-rules").length, 2);

  await writeFile(
    pathRule,
    "---\npaths:\n  - \"src/**/*.ts\"\n---\n# TypeScript\n\nUse strict types and no any.\n"
  );
  const fifth = await runPreStep(
    { agent, messages: fourth.messages, step: 5, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...fourth.messages, user] })
  );
  const fifthRules = fifth.messages.filter((message) => message.source.kind === "auto-rules");
  assert.equal(fifthRules.length, 3);
  assert.match(fifthRules[2].content[0].text, /no any/);

  const subagent = fakeAgent(cwd, {
    session: {
      header: { cwd, delegationDepth: 1, origin: "subagent" },
      surface: { nodes: [] },
      eventAt() {
        return undefined;
      }
    }
  });
  const skipped = await runPreStep(
    { agent: subagent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(skipped.messages.filter((message) => message.source.kind === "auto-rules").length, 0);
});
