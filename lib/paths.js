import { stat } from "node:fs/promises";
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
 *
 * @param {string} cwd - absolute project directory.
 * @returns {string} one filesystem-safe directory component.
 */
export function projectKey(cwd) {
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
 * Walk up from `cwd` until a directory containing one of `markers` is found.
 *
 * This is the project boundary used to share memory between subdirectories of
 * one checkout. When no marker exists the working directory itself is the
 * project, which keeps unrelated folders separate.
 *
 * @param {string} cwd - absolute working directory.
 * @param {string[]} markers - file or directory names such as `.git`.
 * @param {AbortSignal} [signal] - cancellation for the walk.
 * @returns {Promise<string>} absolute project root.
 */
export async function findProjectRoot(cwd, markers, signal) {
  const start = resolve(cwd);
  if (!Array.isArray(markers) || markers.length === 0) return start;
  let current = start;
  for (;;) {
    signal?.throwIfAborted();
    for (const marker of markers) {
      try {
        const info = await stat(join(current, marker));
        signal?.throwIfAborted();
        if (info !== undefined) return current;
      } catch {
        // A permission error on one marker must not hide another marker or a
        // parent project; keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Abbreviate a path below the OS home for model-facing prompts.
 *
 * @param {string} path - absolute path.
 * @returns {string} `~`, `~/…`, or the unchanged path.
 */
export function displayPath(path) {
  const home = homedir().replace(/\/+$/, "");
  if (home.length === 0) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Compute the memory directory for one project.
 *
 * @param {string} memoryRoot - absolute root holding every project folder.
 * @param {string} key - encoded project key.
 * @returns {string} absolute project memory directory.
 */
export function memoryDirectory(memoryRoot, key) {
  return join(memoryRoot, key);
}
