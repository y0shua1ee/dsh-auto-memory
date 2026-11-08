import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemory, touchModified } from "../lib/memory-frontmatter.js";
import { MemoryStore } from "../lib/store.js";

const FIXED = new Date("2026-01-02T03:04:05.000Z");
const STAMP = FIXED.toISOString();

test("touchModified updates nested and top-level values in place", () => {
  const nested = "---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n\nbody\n";
  assert.equal(
    touchModified(nested, FIXED),
    `---\nname: a\ndescription: d\nmetadata:\n  modified: ${STAMP}\n  type: user\n---\n\nbody\n`
  );
  assert.equal(
    touchModified(`---\nname: a\nmetadata:\n  modified: 2020-01-01T00:00:00.000Z\n---\nbody`, FIXED),
    `---\nname: a\nmetadata:\n  modified: ${STAMP}\n---\nbody`
  );
  assert.equal(
    touchModified("---\nname: a\nmodified: 2020-01-01T00:00:00.000Z\n---\nbody", FIXED),
    `---\nname: a\nmodified: ${STAMP}\n---\nbody`
  );
});

test("touchModified preserves CRLF, BOM and files without frontmatter", () => {
  const crlf = "\uFEFF---\r\nname: a\r\nmetadata:\r\n  type: user\r\n---\r\nbody\r\n";
  const result = touchModified(crlf, FIXED);
  assert.match(result, new RegExp(`\\uFEFF---\\r\\nname: a\\r\\nmetadata:\\r\\n  modified: ${STAMP}\\r\\n  type: user\\r\\n---\\r\\nbody\\r\\n`));
  assert.equal(result.includes("\n"), true);
  assert.equal(result.includes("\r\n"), true);
  assert.equal(touchModified("plain body\n", FIXED), "plain body\n");
  assert.equal(touchModified("---\nname: a\n", FIXED), "---\nname: a\n");
});

test("memory writes record modified, edits refresh it, and MEMORY.md is untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-auto-memory-modified-"));
  const store = new MemoryStore({
    root,
    maxFileBytes: 65_536,
    maxIndexBytes: 25_600,
    maxIndexLines: 200,
    maxFiles: 200
  });
  const created = await store.create(
    "prefer-pnpm.md",
    "---\nname: prefer-pnpm\ndescription: use pnpm\nmetadata:\n  type: feedback\n---\n\nbody\n"
  );
  assert.deepEqual(created.frontmatterProblems, []);
  const first = await readFile(join(root, "prefer-pnpm.md"), "utf8");
  const firstStamp = parseMemory(first).modified;
  assert.match(firstStamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(first, /metadata:\n  modified: /);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.strReplace("prefer-pnpm.md", "body", "body 2");
  const second = await readFile(join(root, "prefer-pnpm.md"), "utf8");
  const secondStamp = parseMemory(second).modified;
  assert.notEqual(secondStamp, firstStamp);
  assert.match(second, /body 2/);

  const index = await readFile(join(root, "MEMORY.md"), "utf8");
  assert.doesNotMatch(index, /modified/);
});
