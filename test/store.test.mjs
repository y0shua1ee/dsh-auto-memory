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
  await store.strReplace("notes.md", "BETA", "$& $$ $`");
  assert.equal(await readFile(join(store.root, "notes.md"), "utf8"), "alpha $& $$ $` gamma\n");
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

test("frontmatter names the index entry and missing fields are reported", async () => {
  const { store } = await fixture();
  const created = await store.create(
    "prefer-pnpm.md",
    "---\nname: prefer-pnpm\ndescription: \"Use pnpm, never npm\"\nmetadata:\n  type: feedback\n---\n\nUse pnpm.\n\n**Why:** lockfile.\n**How to apply:** installs.\n"
  );
  assert.deepEqual(created.frontmatterProblems, []);
  assert.match((await store.view("MEMORY.md")).content, /- \[prefer-pnpm\]\(prefer-pnpm\.md\) — Use pnpm, never npm\n/);

  const loose = await store.create("loose.md", "---\nname: Loose Note\nmetadata:\n  type: todo\n---\n\nbody\n");
  assert.deepEqual(loose.frontmatterProblems, [
    'name "Loose Note" is not kebab-case',
    "missing description",
    'metadata.type "todo" is not one of user, feedback, project, reference'
  ]);
  assert.deepEqual((await store.create("plain.md", "# Plain\n")).frontmatterProblems, [
    "no frontmatter (name, description, metadata.type)"
  ]);
  assert.match((await store.view("MEMORY.md")).content, /- \[loose\]\(loose\.md\) — body\n/);
});

test("edits refresh index lines that still match the old frontmatter", async () => {
  const { store } = await fixture();
  const memory = (name, description) =>
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\nbody\n`;
  await store.create("synced.md", memory("synced", "old hook"));
  await store.create("custom.md", memory("custom", "old hook"));
  await store.strReplace("MEMORY.md", "[custom](custom.md) — old hook", "[custom](custom.md) — written by hand");

  const synced = await store.strReplace("synced.md", "description: old hook", "description: new hook");
  assert.equal(synced.indexed, true);
  const custom = await store.strReplace("custom.md", "name: custom\ndescription: old hook", "name: renamed\ndescription: new hook");
  assert.equal(custom.indexed, true);
  const unchanged = await store.insert("custom.md", 8, "more body");
  assert.equal(unchanged.indexed, undefined);

  const index = (await store.view("MEMORY.md")).content;
  assert.match(index, /- \[synced\]\(synced\.md\) — new hook\n/);
  assert.match(index, /- \[renamed\]\(custom\.md\) — written by hand\n/);
});

test("index lines are identified by their leading link only", async () => {
  const { root, store } = await fixture();
  await store.create("a.md", "---\nname: a\ndescription: See [b](b.md) for context\n---\n");
  assert.equal((await store.create("b.md", "---\nname: b\ndescription: bee\n---\n")).indexed, true);
  await store.rename("b.md", "c.md");
  await store.delete("c.md");
  assert.match((await store.view("MEMORY.md")).content, /- \[a\]\(a\.md\) — See \[b\]\(b\.md\) for context\n/);

  await store.create("crlf.md", "---\nname: crlf\ndescription: old\n---\n");
  const index = join(root, "MEMORY.md");
  await writeFile(index, (await readFile(index, "utf8")).replaceAll("\n", "\r\n"));
  assert.equal((await store.strReplace("crlf.md", "description: old", "description: new")).indexed, true);
  assert.match(await readFile(index, "utf8"), /- \[crlf\]\(crlf\.md\) — new\r\n/);
});

test("names must match file names and renames carry generated titles", async () => {
  const { store } = await fixture();
  const memory = (name) => `---\nname: ${name}\ndescription: d\nmetadata:\n  type: user\n---\n`;
  assert.match((await store.create("actual.md", memory("other"))).frontmatterProblems[0], /does not match the file name actual\.md/);
  assert.deepEqual((await store.create("odd.md", memory("a]b"))).frontmatterProblems, ['name "a]b" is not kebab-case']);
  await store.create("plain.md", "# Plain\n");
  await store.create("keep.md", memory("keep"));
  await store.rename("plain.md", "renamed.md");
  const moved = await store.rename("keep.md", "moved.md");
  assert.match(moved.frontmatterProblems[0], /name "keep" does not match the file name moved\.md/);
  const edited = await store.strReplace("moved.md", "type: user", "type: todo");
  assert.deepEqual(edited.frontmatterProblems, ['metadata.type "todo" is not one of user, feedback, project, reference']);
  assert.deepEqual((await store.insert("renamed.md", 1, "more")).frontmatterProblems, []);

  const index = (await store.view("MEMORY.md")).content;
  assert.match(index, /- \[odd\]\(odd\.md\) — d\n/);
  assert.match(index, /- \[renamed\]\(renamed\.md\) — Plain\n/);
  assert.match(index, /- \[keep\]\(moved\.md\) — d\n/);
});

test("paths with whitespace keep one maintainable index line", async () => {
  const { store } = await fixture();
  await store.create("my note.md", "# Note\n");
  assert.match((await store.view("MEMORY.md")).content, /- \[my note\]\(<my note\.md>\) — Note\n/);

  const edited = await store.strReplace("my note.md", "Note", "Note2");
  assert.equal(edited.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[my note\]\(<my note\.md>\) — Note2\n/);

  const deleted = await store.delete("my note.md");
  assert.equal(deleted.indexed, true);
  assert.doesNotMatch((await store.view("MEMORY.md")).content, /my note\.md/);

  await store.create("my note.md", "# Again\n");
  const index = (await store.view("MEMORY.md")).content;
  assert.equal(index.split("\n").filter((line) => line.includes("my note.md")).length, 1);

  const renamed = await store.rename("my note.md", "my-note.md");
  assert.equal(renamed.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[my-note\]\(my-note\.md\) — Again\n/);

  await store.create("my dir/foo.md", "# Foo\n");
  assert.match((await store.view("MEMORY.md")).content, /- \[foo\]\(<my dir\/foo\.md>\) — Foo\n/);
  assert.equal((await store.delete("my dir/foo.md")).indexed, true);

  await store.create(
    "my other note.md",
    "---\nname: my-other-note\ndescription: d\nmetadata:\n  type: user\n---\n"
  );
  assert.equal((await store.rename("my other note.md", "my-other-note.md")).indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[my-other-note\]\(my-other-note\.md\) — d\n/);
});

test("creating an entry in a CRLF index preserves every line ending", async () => {
  const { root, store } = await fixture();
  await store.create("a.md", "# A\n");
  const index = join(root, "MEMORY.md");
  await writeFile(index, (await readFile(index, "utf8")).replaceAll("\n", "\r\n"));

  await store.create("b.md", "# B\n");
  const content = await readFile(index, "utf8");
  assert.match(content, /- \[a\]\(a\.md\) — A\r\n/);
  assert.match(content, /- \[b\]\(b\.md\) — B\r\n/);
  assert.equal(
    content.split("\n").filter((line) => line.length > 0 && !line.endsWith("\r")).length,
    0
  );
});

test("nested memory files warn that [[name]] only resolves at the root", async () => {
  const { store } = await fixture();
  const memory = (name) => `---\nname: ${name}\ndescription: d\nmetadata:\n  type: user\n---\n`;
  const nested = await store.create("sub/nested.md", memory("nested"));
  assert.match(nested.frontmatterProblems[0], /subdirectory/);
  const top = await store.create("top.md", memory("top"));
  assert.deepEqual(top.frontmatterProblems, []);

  const moved = await store.rename("top.md", "sub/top.md");
  assert.match(moved.frontmatterProblems[0], /subdirectory/);
  const back = await store.rename("sub/top.md", "top.md");
  assert.deepEqual(back.frontmatterProblems, []);
});

test("v0.3.0 invalid-name titles are normalized on edit and rename", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "MEMORY.md"), "# Project memory\n\n- [Loose Note](loose.md) — new\n");
  await store.create("loose.md", "---\nname: Loose Note\ndescription: new\nmetadata:\n  type: user\n---\n");
  const edited = await store.strReplace("loose.md", "description: new", "description: newer");
  assert.equal(edited.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[loose\]\(loose\.md\) — newer\n/);

  await writeFile(join(root, "MEMORY.md"), "# Project memory\n\n- [a]b](weird.md) — d\n");
  await store.create("weird.md", "---\nname: a]b\ndescription: d\nmetadata:\n  type: user\n---\n");
  const body = await store.strReplace("weird.md", "description: d", "description: d2");
  assert.equal(body.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[weird\]\(weird\.md\) — d2\n/);

  await writeFile(join(root, "MEMORY.md"), "# Project memory\n\n- [Loose Note](loose2.md) — new\n");
  await store.create("loose2.md", "---\nname: Loose Note\ndescription: new\nmetadata:\n  type: user\n---\n");
  const moved = await store.rename("loose2.md", "moved.md");
  assert.equal(moved.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[moved\]\(moved\.md\) — new\n/);

  await writeFile(join(root, "MEMORY.md"), "# Project memory\n\n- [Loose Note](loose3.md) — d\n");
  await store.create("loose3.md", "---\nname: Loose Note\ndescription: d\nmetadata:\n  type: user\n---\n");
  const renamed = await store.strReplace("loose3.md", "name: Loose Note", "name: loose3");
  assert.equal(renamed.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[loose3\]\(loose3\.md\) — d\n/);

  await writeFile(join(root, "MEMORY.md"), "# Project memory\n\n- [x]y](xy.md) — d\n");
  await store.create("xy.md", "---\nname: x]y\ndescription: d\nmetadata:\n  type: user\n---\n");
  const x = await store.strReplace("xy.md", "description: d", "description: d2");
  assert.equal(x.indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[xy\]\(xy\.md\) — d2\n/);
});

test("changing one invalid frontmatter value does not report the same problem again", async () => {
  const { store } = await fixture();
  await store.create("foo.md", "---\nname: bar\ndescription: d\nmetadata:\n  type: user\n---\n");
  assert.deepEqual((await store.strReplace("foo.md", "name: bar", "name: baz")).frontmatterProblems, []);
  assert.deepEqual((await store.strReplace("foo.md", "type: user", "type: todo")).frontmatterProblems, [
    'metadata.type "todo" is not one of user, feedback, project, reference'
  ]);
  assert.deepEqual((await store.strReplace("foo.md", "type: todo", "type: other")).frontmatterProblems, []);
  assert.deepEqual((await store.rename("foo.md", "foo-2.md")).frontmatterProblems, []);
});

test("task lists and title links are not treated as index lines", async () => {
  const { root, store } = await fixture();
  await writeFile(
    join(root, "MEMORY.md"),
    "# Project memory\n\n- [see [foo](foo.md)](bar.md) — hook\n- [ ] [task](task.md) — task\n"
  );

  assert.equal((await store.create("foo.md", "# Foo\n")).indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[foo\]\(foo\.md\) — Foo\n/);
  assert.equal((await store.delete("foo.md")).indexed, true);
  assert.match(
    (await store.view("MEMORY.md")).content,
    /- \[see \[foo\]\(foo\.md\)\]\(bar\.md\) — hook\n/
  );

  assert.equal((await store.create("task.md", "# Task\n")).indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[task\]\(task\.md\) — Task\n/);
  assert.equal((await store.delete("task.md")).indexed, true);
  assert.match((await store.view("MEMORY.md")).content, /- \[ \] \[task\]\(task\.md\) — task\n/);
});
