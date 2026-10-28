import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

test("plugin wiring: tool, prompt section, injection and dedupe", { skip: !FRAMEWORK_AVAILABLE }, async () => {
  const plugin = await import("../lib/index.js");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
  const { MemoryStore } = await import("../lib/store.js");

  const base = await mkdtemp(join(tmpdir(), "dsh-auto-memory-plugin-"));
  const projectRoot = join(base, "repo");
  const cwd = join(projectRoot, "src");
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const memoryRoot = join(base, "memory");
  const key = projectKey(projectRoot);
  const dir = join(memoryRoot, key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "testing.md"), "# Testing\n\nUse node --test.\n");
  await writeFile(
    join(dir, "MEMORY.md"),
    "# Project memory\n\n- [Testing](testing.md) — use node --test.\n"
  );

  const sections = [];
  const tools = [];
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
      section(section) {
        sections.push(section);
      },
      getSectionOrder() {
        return 2400;
      }
    },
    tools: {
      register(tool) {
        tools.push(tool);
      }
    },
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

  assert.throws(
    () => plugin.resolveConfig({ root: "." }),
    /dedicated directory/
  );
  assert.throws(
    () => plugin.resolveConfig({ root: "/" }),
    /filesystem root/
  );

  plugin.apply(ctx, { root: memoryRoot, rules: false });

  assert.equal(plugin.name, "auto-memory");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "tool:memory");
  assert.match(sections[0].text, /Persistent project memory/);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "memory");

  const agent = fakeAgent(cwd);
  const user = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
  const handler = runPreStep;
  assert.equal(typeof handler, "function");

  const first = await handler(
    { agent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].source.kind, "auto-memory");
  assert.match(first.messages[0].content[0].text, /use node --test/);
  assert.match(first.messages[0].content[0].text, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const firstDigest = first.messages[0].source.digest;

  const claimed = first.messages;
  const second = await handler(
    { agent, messages: claimed, step: 2, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...claimed, user] })
  );
  assert.equal(second.messages.length, claimed.length + 1);
  assert.equal(second.messages.filter((message) => message.source.kind === "auto-memory").length, 1);

  await writeFile(
    join(dir, "MEMORY.md"),
    "# Project memory\n\n- [Testing](testing.md) — use node --test --concurrency=1.\n"
  );
  const third = await handler(
    { agent, messages: second.messages, step: 3, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [...second.messages, user] })
  );
  const injected = third.messages.filter((message) => message.source.kind === "auto-memory");
  assert.equal(injected.length, 2);
  assert.notEqual(injected[1].source.digest, firstDigest);
  assert.match(injected[1].content[0].text, /concurrency=1/);

  const store = new MemoryStore({
    root: dir,
    maxFileBytes: 65_536,
    maxIndexBytes: 25_600,
    maxFiles: 200
  });
  // The plugin's own store instance is cached per project root; this separate
  // instance only checks the on-disk effect of the tool below.
  assert.equal((await store.index()).exists, true);

  const exec = { agent, signal: new AbortController().signal };
  const created = await tools[0].execute(
    { command: "create", path: "/memories/notes.md", file_text: "# Notes\n\nUse pnpm.\n" },
    exec
  );
  assert.match(created.output, /Created \/memories\/notes\.md/);
  assert.match(created.output, /Updated MEMORY\.md/);
  assert.match(await readFile(join(dir, "MEMORY.md"), "utf8"), /\(notes\.md\)/);

  const listing = await tools[0].execute({ command: "view", path: "/memories" }, exec);
  assert.match(listing.output, /notes\.md/);
  assert.match(listing.output, /testing\.md/);

  const file = await tools[0].execute({ command: "view", path: "/memories/notes.md" }, exec);
  assert.equal(file.output, "# Notes\n\nUse pnpm.\n");

  const numbered = await tools[0].execute(
    { command: "view", path: "/memories/notes.md", numbered: true },
    exec
  );
  assert.match(numbered.output, /^ {3}1: # Notes/);

  const edited = await tools[0].execute(
    { command: "str_replace", path: "/memories/notes.md", old_str: "pnpm", new_str: "pnpm --offline" },
    exec
  );
  assert.match(edited.output, /Edited/);
  assert.match(await readFile(join(dir, "notes.md"), "utf8"), /pnpm --offline/);

  const rendered = tools[0].output.render({}, file);
  assert.deepEqual(rendered, [{ type: "text", text: file.output }]);

  await assert.rejects(
    tools[0].execute({ command: "view", path: "/not-memories" }, exec),
    (error) => error.code === "MEMORY_INVALID_PATH"
  );

  await writeFile(
    join(dir, "MEMORY.md"),
    "# Project memory\n\n<!-- One line per memory. -->\n"
  );
  const headerOnly = fakeAgent(cwd);
  const notInjected = await handler(
    { agent: headerOnly, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(notInjected.messages.length, 1);
  assert.equal(notInjected.messages[0].source.kind, "user");

  const subagent = fakeAgent(cwd, {
    session: {
      header: { cwd, delegationDepth: 1, origin: "subagent" },
      surface: { nodes: [] },
      eventAt() {
        return undefined;
      }
    }
  });
  const skipped = await handler(
    { agent: subagent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [user] })
  );
  assert.equal(skipped.messages.length, 1);
  assert.equal(skipped.messages[0].source.kind, "user");
});
