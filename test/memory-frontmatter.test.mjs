import test from "node:test";
import assert from "node:assert/strict";
import { memoryFrontmatterProblems, parseMemory } from "../lib/memory-frontmatter.js";

test("parseMemory reads name, description and metadata.type", () => {
  assert.deepEqual(
    parseMemory('\uFEFF---\r\nname: "prefer-pnpm"\r\ndescription: \'Use pnpm\'\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\nbody\r\n'),
    { frontmatter: true, name: "prefer-pnpm", description: "Use pnpm", type: "feedback", body: "body\n" }
  );
  assert.equal(parseMemory("---\nname: x\ntype: user\n---\n").type, "user");
  assert.equal(parseMemory("---\ntype: user\nmetadata:\n  type: project\n---\n").type, "project");
  assert.equal(parseMemory("---\nname: x\nother:\n  type: user\n---\n").type, undefined);
});

test("parseMemory treats missing or unclosed frontmatter as plain text", () => {
  assert.deepEqual(parseMemory("# Title\n"), { frontmatter: false, body: "# Title\n" });
  assert.deepEqual(parseMemory("---\nname: x\n"), { frontmatter: false, body: "---\nname: x\n" });
});

test("memoryFrontmatterProblems lists every missing or invalid field", () => {
  assert.deepEqual(memoryFrontmatterProblems(parseMemory("body"), "a"), ["no frontmatter (name, description, metadata.type)"]);
  assert.deepEqual(memoryFrontmatterProblems(parseMemory("---\n---\n"), "a"), [
    "missing name",
    "missing description",
    "missing metadata.type"
  ]);
  assert.deepEqual(
    memoryFrontmatterProblems(parseMemory("---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n"), "a"),
    []
  );
  assert.deepEqual(
    memoryFrontmatterProblems(parseMemory("---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n")),
    []
  );
});
