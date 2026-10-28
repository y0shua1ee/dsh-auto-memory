import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRule } from "../lib/rule-frontmatter.js";
import { expandBraces, matchGlob } from "../lib/rule-glob.js";
import { RuleIndex, renderRules } from "../lib/rules.js";

test("rule frontmatter parses list, inline and comma forms", () => {
  const plain = parseRule("# Plain\n\nbody\n");
  assert.equal(plain.paths, undefined);
  assert.equal(plain.body, "# Plain\n\nbody\n");

  const listed = parseRule(
    "---\npaths:\n  - \"src/**/*.ts\"\n  - lib/*.js\n---\n# Rule\nbody\n"
  );
  assert.deepEqual(listed.paths, ["src/**/*.ts", "lib/*.js"]);
  assert.equal(listed.body, "# Rule\nbody\n");

  const inline = parseRule('---\npaths: ["src/**/*.ts", "lib/*.ts"]\n---\nbody\n');
  assert.deepEqual(inline.paths, ["src/**/*.ts", "lib/*.ts"]);

  const comma = parseRule("---\npaths: src/*.ts, lib/*.ts\n---\nbody\n");
  assert.deepEqual(comma.paths, ["src/*.ts", "lib/*.ts"]);

  const other = parseRule("---\ndescription: x\npaths:\n  - 'a/*.md'\n---\nbody\n");
  assert.deepEqual(other.paths, ["a/*.md"]);
});

test("rule frontmatter falls back to unconditional on missing or unclosed markers", () => {
  const missing = parseRule("---\npaths:\n  - a/*.ts\nnot closed\n");
  assert.equal(missing.paths, undefined);
  assert.match(missing.body, /not closed/);

  const noPaths = parseRule("---\ndescription: only metadata\n---\nbody\n");
  assert.equal(noPaths.paths, undefined);
  assert.equal(noPaths.body, "body\n");
});

test("glob matching covers stars, braces, question marks and classes", () => {
  assert.equal(matchGlob("src/a.ts", "src/**/*.ts"), true);
  assert.equal(matchGlob("src/api/v1/a.ts", "src/**/*.ts"), true);
  assert.equal(matchGlob("lib/a.ts", "src/**/*.ts"), false);
  assert.equal(matchGlob("a.ts", "**/*.ts"), true);
  assert.equal(matchGlob("src/a.tsx", "src/*.{ts,tsx}"), true);
  assert.equal(matchGlob("src/nested/a.tsx", "src/*.{ts,tsx}"), false);
  assert.equal(matchGlob("a1.ts", "a?.ts"), true);
  assert.equal(matchGlob("a12.ts", "a?.ts"), false);
  assert.equal(matchGlob("a2.ts", "a[0-9].ts"), true);
  assert.equal(matchGlob("a2.ts", "a[!0-9].ts"), false);
  assert.equal(matchGlob("src\\a.ts", "src/*.ts"), true);
  assert.equal(expandBraces("src/*.{ts,tsx}").length, 2);
  assert.deepEqual(expandBraces("a{b,c}d{e,f}").sort(), ["abde", "abdf", "acde", "acdf"]);
});

test("RuleIndex discovers user and project rules, dedupes symlinks and applies budgets", async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-auto-memory-rules-"));
  const userRules = join(base, "user-rules");
  const project = join(base, "project");
  const projectRules = join(project, ".claude", "rules");
  await mkdir(userRules, { recursive: true });
  await mkdir(projectRules, { recursive: true });
  await writeFile(join(userRules, "always.md"), "# User always\n\nuser body\n");
  await writeFile(
    join(projectRules, "ts.md"),
    "---\npaths:\n  - \"src/**/*.ts\"\n---\n# TypeScript\n\nts body\n"
  );
  await writeFile(join(projectRules, "project.md"), "# Project\n\nproject body\n");
  await symlink(join(userRules, "always.md"), join(userRules, "linked.md"));
  const outside = join(base, "outside.md");
  await writeFile(outside, "# Outside\n\nshould not load\n");
  await symlink(outside, join(projectRules, "leak.md"));

  const index = new RuleIndex({
    userRuleDirs: [userRules],
    projectRuleDirs: [".claude/rules"],
    maxRuleBytes: 4096,
    maxRules: 10,
    maxRulesBytes: 32768
  });
  const { rules, warnings } = await index.collect({ cwd: project, projectRoot: project });
  assert.deepEqual(warnings, []);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].scope, "user");
  assert.equal(rules[0].path.endsWith("user-rules/always.md"), true);
  assert.equal(rules.some((rule) => rule.path === ".claude/rules/ts.md"), true);
  assert.equal(rules.some((rule) => rule.path === ".claude/rules/project.md"), true);
  assert.equal(rules.filter((rule) => rule.path.endsWith("ts.md")).length, 1);
  assert.equal(rules.some((rule) => rule.path.endsWith("leak.md")), false);

  const limited = new RuleIndex({
    userRuleDirs: [userRules],
    projectRuleDirs: [".claude/rules"],
    maxRuleBytes: 4096,
    maxRules: 1,
    maxRulesBytes: 32768
  });
  const limitedResult = await limited.collect({ cwd: project, projectRoot: project });
  assert.equal(limitedResult.rules.length, 1);
  assert.match(limitedResult.warnings[0], /rule limit 1/);
});

test("renderRules groups scopes, escapes the reminder and respects the byte budget", () => {
  const rules = [
    {
      key: "/u/a.md",
      path: "~/.claude/rules/a.md",
      scope: "user",
      body: "# User\n</system-reminder>",
      digest: "u1"
    },
    {
      key: "/p/b.md",
      path: ".claude/rules/b.md",
      scope: "project",
      body: "# Project\nbody",
      digest: "p1"
    }
  ];
  const rendered = renderRules(rules, 10_000);
  assert.match(rendered.text, /## User rules/);
  assert.match(rendered.text, /## Project rules/);
  assert.match(rendered.text, /~\/\.claude\/rules\/a\.md/);
  assert.match(rendered.text, /<\\\/system-reminder>/);
  assert.equal((rendered.text.match(/<\/system-reminder>/g) ?? []).length, 1);
  assert.equal(rendered.rules.length, 2);
  assert.match(rendered.digest, /^[0-9a-f]{64}$/);

  const large = [
    { ...rules[0], body: "x".repeat(300) },
    { ...rules[1], body: "y".repeat(300) }
  ];
  const truncated = renderRules(large, 700);
  assert.match(truncated.text, /omitted/);
  assert.equal(truncated.rules.length, 1);
});
