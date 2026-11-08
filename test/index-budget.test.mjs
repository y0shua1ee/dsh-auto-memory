import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryError, MemoryStore } from "../lib/store.js";
import { renderMemoryContext } from "../lib/render.js";
import { buildMemoryToolOptions } from "../lib/tool.js";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-auto-memory-budget-"));
  const store = new MemoryStore({
    root,
    maxFileBytes: options.maxFileBytes ?? 65_536,
    maxIndexBytes: options.maxIndexBytes ?? 512,
    maxIndexLines: options.maxIndexLines ?? 200,
    maxFiles: options.maxFiles ?? 200
  });
  return { root, store };
}

test("index near its budget warns, then over-budget writes still land and throw", async () => {
  const { root, store } = await fixture();
  await store.create("MEMORY.md", "");
  let warned = false;
  let over;
  for (let index = 0; index < 40; index += 1) {
    try {
      const result = await store.create(`m${index}.md`, "# T\n");
      if (result.indexBudgetWarning !== undefined) {
        warned = true;
        assert.match(result.indexBudgetWarning, /near its read limit/);
      }
    } catch (error) {
      over = error;
      break;
    }
  }
  assert.equal(warned, true);
  assert.ok(over instanceof MemoryError);
  assert.equal(over.code, "MEMORY_INDEX_OVER_LIMIT");
  assert.match(over.message, /change was applied/);
  assert.match(over.message, /rewrite the index/i);

  const index = await readFile(join(root, "MEMORY.md"), "utf8");
  assert.match(index, /\(m\d+\.md\)/);
  const last = index.split("\n").find((line) => line.startsWith("- [m"));
  assert.ok(last !== undefined);
});

test("an 81KB index is read in full instead of refusing injection", async () => {
  const { root, store } = await fixture({ maxIndexBytes: 25_600, maxFileBytes: 65_536 });
  const lines = Array.from({ length: 4_500 }, (_, index) => `- [m${index}](m${index}.md) — hook`);
  const content = `# Project memory\n\n${lines.join("\n")}\n`;
  assert.ok(Buffer.byteLength(content, "utf8") > 65_536);
  await writeFile(join(root, "MEMORY.md"), content);

  const index = await store.index();
  assert.equal(index.exists, true);
  assert.equal(index.truncated, false);
  assert.equal(index.content, content);

  const rendered = renderMemoryContext({
    content: index.content,
    memoryDir: "~/.dsh/auto-memory/x",
    projectKey: "x",
    maxBytes: 25_600,
    maxLines: 200
  });
  assert.equal(rendered.truncated, true);
  assert.match(rendered.text, /truncated/);
});

test("an index over the 4MiB safety cap is read as a marked prefix", async () => {
  const { root, store } = await fixture({ maxIndexBytes: 25_600, maxFileBytes: 65_536 });
  const cap = 4 * 1024 * 1024;
  const content = `# Project memory\n${"x".repeat(cap + 100)}\n`;
  await writeFile(join(root, "MEMORY.md"), content);

  const index = await store.index();
  assert.equal(index.exists, true);
  assert.equal(index.truncated, true);
  assert.equal(Buffer.byteLength(index.content, "utf8"), cap);

  const rendered = renderMemoryContext({
    content: index.content,
    memoryDir: "~/.dsh/auto-memory/x",
    projectKey: "x",
    maxBytes: 25_600,
    maxLines: 200,
    sourceTruncated: index.truncated
  });
  assert.equal(rendered.truncated, true);
  assert.match(rendered.text, /safety cap/);
});

test("direct MEMORY.md writes over the budget still succeed on disk", async () => {
  const { root, store } = await fixture();
  const body = `# Project memory\n\n${"- [m](m.md) — hook\n".repeat(40)}`;
  await assert.rejects(
    store.create("MEMORY.md", body),
    (error) => error instanceof MemoryError && error.code === "MEMORY_INDEX_OVER_LIMIT"
  );
  assert.equal(await readFile(join(root, "MEMORY.md"), "utf8"), body);
  assert.equal((await store.view("MEMORY.md")).kind, "file");
});

test("memory tool output carries the near-limit warning and the over-limit error", async () => {
  const { store } = await fixture();
  const tool = buildMemoryToolOptions({
    projectFor: async () => ({ store })
  });
  const exec = { agent: { session: {}, inbox: {} } };
  await tool.execute({ command: "create", path: "/memories/MEMORY.md", file_text: "" }, exec);
  let warned;
  for (let index = 0; index < 40; index += 1) {
    try {
      const result = await tool.execute(
        { command: "create", path: `/memories/t${index}.md`, file_text: "# T\n" },
        exec
      );
      if (result.output.includes("near its read limit")) warned = result.output;
    } catch (error) {
      assert.equal(error.code, "MEMORY_INDEX_OVER_LIMIT");
      assert.match(error.message, /rewrite the index/i);
      break;
    }
  }
  assert.match(warned ?? "", /near its read limit/);
});

test("the 200-line limit reports before a new entry silently falls out of the injected index", async () => {
  const { root, store } = await fixture({ maxIndexBytes: 1_000_000, maxIndexLines: 200, maxFiles: 300 });
  await store.create("MEMORY.md", "");
  let warned = false;
  let over;
  let lastIndex = -1;
  for (let index = 0; index < 260; index += 1) {
    try {
      const result = await store.create(`line-${index}.md`, "# T\n");
      if (result.indexBudgetWarning !== undefined) warned = true;
      lastIndex = index;
    } catch (error) {
      over = error;
      break;
    }
  }
  assert.equal(warned, true);
  assert.ok(over instanceof MemoryError);
  assert.equal(over.code, "MEMORY_INDEX_OVER_LIMIT");
  const content = await readFile(join(root, "MEMORY.md"), "utf8");
  assert.match(content, new RegExp(`line-${lastIndex + 1}\\.md`));
  assert.ok(content.split("\n").length > 200);
});
