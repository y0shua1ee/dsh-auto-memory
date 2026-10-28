import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryError, MemoryStore } from "../lib/store.js";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-auto-memory-store-"));
  const store = new MemoryStore({
    root,
    maxFileBytes: options.maxFileBytes ?? 4096,
    maxIndexBytes: options.maxIndexBytes ?? 2048,
    maxFiles: options.maxFiles ?? 10
  });
  return { root, store };
}

test("create, view, list and automatic index maintenance", async () => {
  const { store } = await fixture();
  assert.deepEqual(await store.view(""), { kind: "directory", entries: [] });

  const index = await store.create("MEMORY.md", "");
  assert.equal(index.path, "/memories/MEMORY.md");
  assert.ok(index.bytes > 0);
  assert.match(await readFile(join(store.root, "MEMORY.md"), "utf8"), /Project memory/);

  const created = await store.create("testing.md", "# Testing\n\nUse node --test.\n");
  assert.equal(created.path, "/memories/testing.md");
  assert.equal(created.indexed, true);

  const indexFile = await store.view("MEMORY.md");
  assert.match(indexFile.content, /- \[testing\]\(testing\.md\) — Testing/);

  const view = await store.view("testing.md");
  assert.equal(view.content, "# Testing\n\nUse node --test.\n");
  assert.equal(view.lines, 4);

  const listing = await store.list("");
  assert.deepEqual(
    listing.map((entry) => [entry.path, entry.kind]),
    [
      ["/memories/MEMORY.md", "file"],
      ["/memories/testing.md", "file"]
    ]
  );
});

test("str_replace requires exactly one match", async () => {
  const { store } = await fixture();
  await store.create("notes.md", "alpha beta gamma\n");
  const result = await store.strReplace("notes.md", "beta", "BETA");
  assert.equal(result.bytes, 17);
  await assert.rejects(
    store.strReplace("notes.md", "missing", "x"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_NO_MATCH"
  );
  await store.create("dup.md", "same same\n");
  await assert.rejects(
    store.strReplace("dup.md", "same", "x"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_MULTIPLE_MATCHES"
  );
});

test("insert uses zero-based lines and preserves the rest", async () => {
  const { store } = await fixture();
  await store.create("notes.md", "one\ntwo\n");
  const result = await store.insert("notes.md", 1, "middle");
  assert.equal((await readFile(join(store.root, "notes.md"), "utf8")), "one\nmiddle\ntwo\n");
  assert.equal(result.insertedAt, 1);
  await store.insert("notes.md", 0, "zero");
  assert.equal((await readFile(join(store.root, "notes.md"), "utf8")), "zero\none\nmiddle\ntwo\n");
});

test("rename and delete follow index links", async () => {
  const { store } = await fixture();
  await store.create("MEMORY.md", "");
  await store.create("notes.md", "# Notes\n\nbody\n");
  const renamed = await store.rename("notes.md", "archive/notes-old.md");
  assert.equal(renamed.indexed, true);
  const index = await store.view("MEMORY.md");
  assert.match(index.content, /\(archive\/notes-old\.md\)/);
  assert.doesNotMatch(index.content, /\(notes\.md\)/);

  const deleted = await store.delete("archive/notes-old.md");
  assert.equal(deleted.indexed, true);
  assert.doesNotMatch((await store.view("MEMORY.md")).content, /notes-old/);
});

test("path traversal, hidden paths and non-markdown files are refused", async () => {
  const { store } = await fixture();
  for (const path of ["/memories/../escape.md", "/memories/.secret.md", "/memories/a//b.md", "other/x.md"]) {
    assert.throws(() => MemoryStore.parseVirtualPath(path), (error) => error instanceof MemoryError);
  }
  await assert.rejects(
    store.create("notes.txt", "x"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_INVALID_PATH"
  );
  assert.throws(
    () => MemoryStore.parseVirtualPath("/memories/bad[name].md"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_INVALID_PATH"
  );
});

test("symlinks inside the memory directory are never followed", async () => {
  const { root, store } = await fixture();
  const outside = join(root, "..", `outside-${Date.now()}.md`);
  await writeFile(outside, "outside");
  await symlink(outside, join(root, "link.md"));
  await assert.rejects(
    store.view("link.md"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_SYMLINK"
  );
});

test("size and file-count limits fail with actionable codes", async () => {
  const { store } = await fixture({ maxFileBytes: 1024, maxFiles: 3 });
  await assert.rejects(
    store.create("big.md", "x".repeat(2000)),
    (error) => error instanceof MemoryError && error.code === "MEMORY_TOO_LARGE"
  );
  await store.create("one.md", "1");
  await store.create("two.md", "2");
  await assert.rejects(
    store.create("three.md", "3"),
    (error) => error instanceof MemoryError && error.code === "MEMORY_TOO_MANY_FILES"
  );
});

test("concurrent creates serialize and keep both index entries", async () => {
  const { store } = await fixture();
  await Promise.all([
    store.create("alpha.md", "# Alpha\n"),
    store.create("beta.md", "# Beta\n")
  ]);
  const index = await store.view("MEMORY.md");
  assert.match(index.content, /alpha\.md/);
  assert.match(index.content, /beta\.md/);
  const lines = index.content.split("\n").filter((line) => line.startsWith("- ["));
  assert.equal(lines.length, 2);
});
