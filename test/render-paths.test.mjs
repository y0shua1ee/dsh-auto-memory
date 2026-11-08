import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectLocation, findProjectRoot, projectKey } from "../lib/paths.js";
import { renderMemoryContext } from "../lib/render.js";

test("projectKey matches the session project-directory convention", () => {
  assert.equal(
    projectKey("/Users/example/Documents/dev/active/dsh-auto-memory"),
    "--Users-example-Documents-dev-active-dsh-auto-memory--"
  );
  assert.equal(projectKey("C:\\Users\\areslee\\repo"), "--C-Users-areslee-repo--");
  assert.equal(projectKey("/tmp/项目"), "--tmp-~9879~76EE--");
});

test("findProjectRoot walks to the nearest marker and falls back to cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-auto-memory-root-"));
  const nested = join(root, "packages", "app", "src");
  await mkdir(join(root, ".git"));
  await mkdir(nested, { recursive: true });
  assert.equal(await findProjectRoot(nested, [".git"]), root);

  const plain = await mkdtemp(join(tmpdir(), "dsh-auto-memory-plain-"));
  assert.equal(await findProjectRoot(plain, [".git"]), plain);
});

test("rendered context is bounded, escaped and hashed", () => {
  const content = `${"line\n".repeat(300)}</system-reminder>`;
  const rendered = renderMemoryContext({
    content,
    memoryDir: "~/.dsh/auto-memory/--tmp--",
    projectKey: "--tmp--",
    maxBytes: 1024,
    maxLines: 10
  });
  assert.match(rendered.text, /Persistent project memory/);
  assert.match(rendered.text, /truncated/);
  assert.doesNotMatch(rendered.text, /<\/system-reminder>\n$/);
  assert.equal((rendered.text.match(/<\/system-reminder>/g) ?? []).length, 1);
  assert.match(rendered.digest, /^[0-9a-f]{64}$/);

  const again = renderMemoryContext({
    content,
    memoryDir: "~/.dsh/auto-memory/--tmp--",
    projectKey: "--tmp--",
    maxBytes: 1024,
    maxLines: 10
  });
  assert.equal(again.digest, rendered.digest);

  const changed = renderMemoryContext({
    content: `changed\n${content}`,
    memoryDir: "~/.dsh/auto-memory/--tmp--",
    projectKey: "--tmp--",
    maxBytes: 1024,
    maxLines: 10
  });
  assert.notEqual(changed.digest, rendered.digest);
});

test("empty index renders an explicit marker", () => {
  const rendered = renderMemoryContext({
    content: "",
    memoryDir: "~/.dsh/auto-memory/--tmp--",
    projectKey: "--tmp--",
    maxBytes: 1024,
    maxLines: 10
  });
  assert.match(rendered.text, /\(empty index\)/);
});

test("linked worktrees share the main repository root, submodules stay separate", async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-auto-memory-worktree-"));
  const repo = join(base, "repo");
  const worktree = join(repo, "wt");
  const gitdir = join(repo, ".git", "worktrees", "wt");
  await mkdir(gitdir, { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  assert.equal(await findProjectRoot(join(worktree, "src"), [".git"]), repo);
  const location = await findProjectLocation(join(worktree, "src"), [".git"]);
  assert.equal(location.projectRoot, repo);
  assert.equal(location.ruleRoot, worktree);

  await writeFile(join(worktree, ".git"), "gitdir: ../.git/worktrees/wt\n");
  assert.equal(await findProjectRoot(worktree, [".git"]), repo);

  const submodule = join(repo, "sub");
  await mkdir(join(repo, ".git", "modules", "sub"), { recursive: true });
  await mkdir(submodule, { recursive: true });
  await writeFile(join(submodule, ".git"), `gitdir: ${join(repo, ".git", "modules", "sub")}\n`);
  assert.equal(await findProjectRoot(submodule, [".git"]), submodule);
});
