import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Encode one project directory the same way DSH names its session project
 * directories: separator and drive runs collapse to a single `-`, unsafe code
 * units use `~XXXX`, and the result is wrapped in `--…--`.
 *
 * Keeping this identical to `@deepseek-ai/dsh-session-persistence-jsonl` means
 * memory folders sit next to the session folders they belong to when the user
 * browses `~/.dsh`.
 */
export function projectKey(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("auto-memory: cannot encode an empty project path");
  }
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Map a linked git worktree to the repository it shares with its main checkout.
 *
 * A linked worktree stores a `.git` file whose `gitdir:` points at
 * `<main>/.git/worktrees/<name>`. Claude Code keys auto memory by repository,
 * so the main checkout directory is the project root. Submodules store a
 * `gitdir:` under `.git/modules/` and stay separate.
 */
async function resolveWorktreeRoot(candidate: string, signal?: AbortSignal): Promise<string> {
  const gitPath = join(candidate, ".git");
  let info;
  try {
    info = await stat(gitPath);
  } catch {
    return candidate;
  }
  if (!info.isFile()) return candidate;
  let text: string;
  try {
    text = await readFile(gitPath, "utf8");
  } catch {
    return candidate;
  }
  signal?.throwIfAborted();
  const match = /^gitdir:\s*(.+?)\s*$/mu.exec(text);
  if (match === null) return candidate;
  const gitdir = resolve(candidate, match[1].replaceAll("\\", "/"));
  const worktree = /(?:^|\/)\.git\/worktrees\/[^/]+\/?$/u.exec(gitdir);
  if (worktree === null || !gitdir.endsWith(worktree[0])) return candidate;
  const root = gitdir.slice(0, gitdir.length - worktree[0].length);
  if (root.length === 0) return candidate;
  try {
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) return candidate;
  } catch {
    return candidate;
  }
  return root;
}

/** The memory key root and the directory project rules are anchored to. */
export interface ProjectLocation {
  /** Shared memory key: the main checkout for linked worktrees. */
  projectRoot: string;
  /** Directory that owns `.claude/rules` / `.dsh/rules` for this session. */
  ruleRoot: string;
}

/**
 * Walk up from `cwd` until a directory containing one of `markers` is found.
 *
 * Memory is keyed by `projectRoot` (a linked worktree resolves to its main
 * checkout), while project rules and their `paths` base stay anchored to the
 * checkout the session actually works in (`ruleRoot`). When no marker exists
 * the working directory is both.
 */
export async function findProjectLocation(
  cwd: string,
  markers: string[],
  signal?: AbortSignal
): Promise<ProjectLocation> {
  const start = resolve(cwd);
  if (!Array.isArray(markers) || markers.length === 0) {
    return { projectRoot: start, ruleRoot: start };
  }
  let current = start;
  for (;;) {
    signal?.throwIfAborted();
    for (const marker of markers) {
      try {
        const info = await stat(join(current, marker));
        signal?.throwIfAborted();
        if (info !== undefined) {
          return {
            projectRoot: marker === ".git" ? await resolveWorktreeRoot(current, signal) : current,
            ruleRoot: current
          };
        }
      } catch {
        // A permission error on one marker must not hide another marker or a
        // parent project; keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) return { projectRoot: start, ruleRoot: start };
    current = parent;
  }
}

/**
 * Return only the memory project root (the main checkout for linked worktrees).
 */
export async function findProjectRoot(
  cwd: string,
  markers: string[],
  signal?: AbortSignal
): Promise<string> {
  const location = await findProjectLocation(cwd, markers, signal);
  return location.projectRoot;
}

/**
 * Abbreviate a path below the OS home for model-facing prompts.
 */
export function displayPath(path: string): string {
  const home = homedir().replace(/\/+$/, "");
  if (home.length === 0) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Compute the memory directory for one project.
 */
export function memoryDirectory(memoryRoot: string, key: string): string {
  return join(memoryRoot, key);
}
