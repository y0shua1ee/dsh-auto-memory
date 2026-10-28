import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { memoryFrontmatterProblems, parseMemory } from "./memory-frontmatter.js";

/** Name of the index file loaded into every session. */
export const INDEX_FILE = "MEMORY.md";

/** Virtual root exposed to the model. */
export const VIRTUAL_ROOT = "/memories";

/** Header written when the index is created automatically. */
export const INDEX_HEADER = `# Project memory

<!-- One line per memory: - [name](name.md) — description. Keep this index short; details live in the memory files. -->
`;

const MAX_PATH_SEGMENTS = 4;
const MAX_RELATIVE_PATH_LENGTH = 200;
const MAX_LIST_DEPTH = MAX_PATH_SEGMENTS;
const SAFE_SEGMENT = /^[^\\/\u0000-\u001f\u007f:*?"<>|#%\[\]()]+$/u;

/** A memory operation failed with a model-actionable reason. */
export class MemoryError extends Error {
  /**
   * @param {string} message - human-readable explanation.
   * @param {string} code - stable uppercase code returned to the model.
   */
  constructor(message, code = "MEMORY_ERROR") {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value) {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function virtual(relativePath) {
  return relativePath.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${relativePath}`;
}

/**
 * Read and write one project's memory directory.
 *
 * Every path is virtual: `/memories` is the directory and
 * `/memories/MEMORY.md` is the index. The store refuses traversal, symlinks,
 * non-Markdown files, and writes that would exceed the configured limits.
 * Mutations are serialized per store instance, so two tool calls from the same
 * process cannot interleave a read-modify-write cycle.
 */
export class MemoryStore {
  #queue = Promise.resolve();

  /**
   * @param {object} options - store limits and the absolute project directory.
   * @param {string} options.root - absolute project memory directory.
   * @param {number} options.maxFileBytes - maximum bytes per file.
   * @param {number} options.maxIndexBytes - injected index budget.
   * @param {number} options.maxFiles - maximum number of `.md` files.
   */
  constructor({ root, maxFileBytes, maxIndexBytes, maxFiles }) {
    this.root = resolve(root);
    this.maxFileBytes = maxFileBytes;
    this.maxIndexBytes = maxIndexBytes;
    this.maxFiles = maxFiles;
  }

  /** Run one mutation after every earlier mutation and return its result. */
  #run(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Parse a model-supplied virtual path.
   *
   * @param {unknown} value - path such as `/memories/MEMORY.md`.
   * @returns {string} project-relative path, or `''` for the root.
   */
  static parseVirtualPath(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new MemoryError("path is required and must be a string", "MEMORY_INVALID_PATH");
    }
    const raw = value.trim();
    if (raw === VIRTUAL_ROOT || raw === `${VIRTUAL_ROOT}/`) return "";
    if (!raw.startsWith(`${VIRTUAL_ROOT}/`)) {
      throw new MemoryError(
        `path must start with ${VIRTUAL_ROOT} (received ${JSON.stringify(value)})`,
        "MEMORY_INVALID_PATH"
      );
    }
    const relativePath = raw.slice(VIRTUAL_ROOT.length + 1);
    const segments = relativePath.split("/");
    if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
      throw new MemoryError(`path may have at most ${MAX_PATH_SEGMENTS} segments`, "MEMORY_INVALID_PATH");
    }
    for (const segment of segments) {
      if (segment.length === 0) {
        throw new MemoryError("path must not contain empty segments or a trailing slash", "MEMORY_INVALID_PATH");
      }
      if (segment === "." || segment === ".." || segment.startsWith(".")) {
        throw new MemoryError("path must not contain relative or hidden segments", "MEMORY_INVALID_PATH");
      }
      if (/[. ]$/u.test(segment)) {
        throw new MemoryError("path segments must not end with a dot or space", "MEMORY_INVALID_PATH");
      }
      if (!SAFE_SEGMENT.test(segment)) {
        throw new MemoryError(
          `path segment ${JSON.stringify(segment)} contains unsupported characters`,
          "MEMORY_INVALID_PATH"
        );
      }
    }
    if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
      throw new MemoryError("path is too long", "MEMORY_INVALID_PATH");
    }
    return segments.join("/");
  }

  #assertFile(relativePath) {
    if (relativePath.length === 0) {
      throw new MemoryError("this command requires a file path under /memories", "MEMORY_INVALID_ARGUMENT");
    }
    if (extname(relativePath).toLowerCase() !== ".md") {
      throw new MemoryError("memory files must use the .md extension", "MEMORY_INVALID_PATH");
    }
    return relativePath;
  }

  #absolute(relativePath) {
    const target = resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new MemoryError("path escapes the memory directory", "MEMORY_INVALID_PATH");
    }
    return target;
  }

  async #lstat(absolutePath) {
    try {
      return await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  async #assertSafeAncestors(relativePath) {
    const segments = relativePath.split("/").slice(0, -1);
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      const info = await this.#lstat(current);
      if (info === undefined) return;
      if (info.isSymbolicLink()) {
        throw new MemoryError("path traverses a symbolic link", "MEMORY_SYMLINK");
      }
      if (!info.isDirectory()) {
        throw new MemoryError("a path component is not a directory", "MEMORY_NOT_A_DIRECTORY");
      }
    }
  }

  async #readText(relativePath, limit = this.maxFileBytes) {
    const absolutePath = this.#absolute(relativePath);
    await this.#assertSafeAncestors(relativePath);
    const info = await this.#lstat(absolutePath);
    if (info === undefined) {
      throw new MemoryError(`${virtual(relativePath)} does not exist`, "MEMORY_NOT_FOUND");
    }
    if (info.isSymbolicLink()) {
      throw new MemoryError(`${virtual(relativePath)} is a symbolic link`, "MEMORY_SYMLINK");
    }
    if (!info.isFile()) {
      throw new MemoryError(`${virtual(relativePath)} is not a file`, "MEMORY_NOT_A_FILE");
    }
    if (info.size > limit) {
      throw new MemoryError(
        `${virtual(relativePath)} is ${info.size} bytes, above the ${limit}-byte read limit`,
        "MEMORY_TOO_LARGE"
      );
    }
    const content = await readFile(absolutePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > limit) {
      throw new MemoryError(
        `${virtual(relativePath)} grew above the ${limit}-byte read limit`,
        "MEMORY_TOO_LARGE"
      );
    }
    if (content.includes("\0")) {
      throw new MemoryError(`${virtual(relativePath)} is not a text file`, "MEMORY_NOT_A_FILE");
    }
    return { content, size: info.size, mtimeMs: info.mtimeMs };
  }

  async #atomicWrite(relativePath, content) {
    if (content.includes("\0")) {
      throw new MemoryError("memory files must be text without NUL bytes", "MEMORY_INVALID_ARGUMENT");
    }
    const absolutePath = this.#absolute(relativePath);
    await this.#assertSafeAncestors(relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporary = join(dirname(absolutePath), `.${basename(absolutePath)}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await renameFile(temporary, absolutePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { bytes: byteLength(content), lines: lineCount(content) };
  }

  #assertWithinFileBudget(relativePath, content) {
    const bytes = byteLength(content);
    if (bytes > this.maxFileBytes) {
      throw new MemoryError(
        `${virtual(relativePath)} would be ${bytes} bytes, above the ${this.maxFileBytes}-byte limit; split it into topic files`,
        "MEMORY_TOO_LARGE"
      );
    }
    return bytes;
  }

  async #list(relativePath) {
    const absolutePath = this.#absolute(relativePath);
    await this.#assertSafeAncestors(relativePath);
    const info = await this.#lstat(absolutePath);
    if (info === undefined) {
      if (relativePath.length === 0) return [];
      throw new MemoryError(`${virtual(relativePath)} does not exist`, "MEMORY_NOT_FOUND");
    }
    if (info.isSymbolicLink() && relativePath.length > 0) {
      throw new MemoryError(`${virtual(relativePath)} is a symbolic link`, "MEMORY_SYMLINK");
    }
    if (!info.isDirectory()) {
      throw new MemoryError(`${virtual(relativePath)} is not a directory`, "MEMORY_NOT_A_DIRECTORY");
    }
    const entries = [];
    const walk = async (directory, prefix, depth) => {
      if (depth > MAX_LIST_DEPTH) return;
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.name.startsWith(".")) continue;
        const childAbsolute = join(directory, child.name);
        const childRelative = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
        const childInfo = await this.#lstat(childAbsolute);
        if (childInfo === undefined || childInfo.isSymbolicLink()) continue;
        if (childInfo.isDirectory()) {
          entries.push({ path: virtual(childRelative), kind: "directory", bytes: 0 });
          await walk(childAbsolute, childRelative, depth + 1);
        } else if (childInfo.isFile()) {
          entries.push({ path: virtual(childRelative), kind: "file", bytes: childInfo.size });
        }
      }
    };
    await walk(absolutePath, relativePath, 0);
    return entries;
  }

  async #fileCount() {
    const entries = await this.#list("");
    return entries.filter((entry) => entry.kind === "file").length;
  }

  /**
   * Read the index, if it exists.
   *
   * @returns {Promise<{exists: boolean, content?: string, bytes?: number}>}
   */
  async index() {
    const absolutePath = this.#absolute(INDEX_FILE);
    const info = await this.#lstat(absolutePath);
    if (info === undefined) return { exists: false };
    if (info.isSymbolicLink()) {
      throw new MemoryError(`${INDEX_FILE} is a symbolic link`, "MEMORY_SYMLINK");
    }
    if (!info.isFile()) return { exists: false };
    const limit = Math.max(this.maxFileBytes, this.maxIndexBytes);
    if (info.size > limit) {
      throw new MemoryError(
        `${INDEX_FILE} is ${info.size} bytes, above the ${limit}-byte read limit`,
        "MEMORY_TOO_LARGE"
      );
    }
    const content = await readFile(absolutePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > limit) {
      throw new MemoryError(`${INDEX_FILE} grew above the ${limit}-byte read limit`, "MEMORY_TOO_LARGE");
    }
    if (content.includes("\0")) {
      throw new MemoryError(`${INDEX_FILE} is not a text file`, "MEMORY_NOT_A_FILE");
    }
    return { exists: true, content, bytes: info.size, mtimeMs: info.mtimeMs };
  }

  /**
   * List the root or one subtree.
   *
   * @param {string} relativePath - project-relative directory.
   * @returns {Promise<Array<{path: string, kind: string, bytes: number}>>}
   */
  async list(relativePath = "") {
    return this.#list(relativePath);
  }

  /**
   * Read one file or list one directory.
   *
   * @param {string} relativePath - project-relative path.
   * @returns {Promise<object>} either `{kind: 'directory', entries}` or
   *   `{kind: 'file', content, bytes, lines}`.
   */
  async view(relativePath = "") {
    if (relativePath.length === 0) {
      return { kind: "directory", entries: await this.#list("") };
    }
    const absolutePath = this.#absolute(relativePath);
    await this.#assertSafeAncestors(relativePath);
    const info = await this.#lstat(absolutePath);
    if (info === undefined) {
      throw new MemoryError(`${virtual(relativePath)} does not exist`, "MEMORY_NOT_FOUND");
    }
    if (info.isSymbolicLink()) {
      throw new MemoryError(`${virtual(relativePath)} is a symbolic link`, "MEMORY_SYMLINK");
    }
    if (info.isDirectory()) {
      return { kind: "directory", entries: await this.#list(relativePath) };
    }
    const read = await this.#readText(
      relativePath,
      relativePath === INDEX_FILE ? Math.max(this.maxFileBytes, this.maxIndexBytes) : this.maxFileBytes
    );
    return {
      kind: "file",
      content: read.content,
      bytes: read.size,
      lines: lineCount(read.content)
    };
  }

  /**
   * Create a new file. Creating a topic file also appends an index entry when
   * the index exists and does not already link the file, and reports what its
   * frontmatter is missing without refusing the write.
   *
   * @param {string} relativePath - file path ending in `.md`.
   * @param {string} [text] - complete file content.
   * @returns {Promise<object>} written file metadata plus optional index and frontmatter warnings.
   */
  async create(relativePath, text) {
    this.#assertFile(relativePath);
    return this.#run(async () => {
      const absolutePath = this.#absolute(relativePath);
      await this.#assertSafeAncestors(relativePath);
      if (await this.#lstat(absolutePath)) {
        throw new MemoryError(`${virtual(relativePath)} already exists; use str_replace or insert`, "MEMORY_ALREADY_EXISTS");
      }
      if ((await this.#fileCount()) >= this.maxFiles) {
        throw new MemoryError(
          `memory already holds ${this.maxFiles} files; delete or merge some before creating another`,
          "MEMORY_TOO_MANY_FILES"
        );
      }
      const content = typeof text === "string" ? text : "";
      const next = relativePath === INDEX_FILE && content.trim().length === 0 ? INDEX_HEADER : content;
      this.#assertWithinFileBudget(relativePath, next);
      const written = await this.#atomicWrite(relativePath, next);
      let indexWarning;
      let indexed = false;
      let frontmatterProblems = [];
      if (relativePath !== INDEX_FILE) {
        frontmatterProblems = memoryFrontmatterProblems(parseMemory(next));
        try {
          indexed = (await this.#linkIndex(relativePath, next)).updated;
        } catch (error) {
          indexWarning = `created the file, but could not update MEMORY.md: ${error.message}`;
        }
      }
      return { path: virtual(relativePath), ...written, indexed, indexWarning, frontmatterProblems };
    });
  }

  /**
   * Replace exactly one occurrence of `oldStr`. Editing a topic file also
   * refreshes its index line when that line still matches the old frontmatter.
   *
   * @param {string} relativePath - file path.
   * @param {string} oldStr - non-empty text that must occur exactly once.
   * @param {string} [newStr] - replacement text, possibly empty.
   * @returns {Promise<object>} written file metadata plus optional index status.
   */
  async strReplace(relativePath, oldStr, newStr = "") {
    this.#assertFile(relativePath);
    if (typeof oldStr !== "string" || oldStr.length === 0) {
      throw new MemoryError("old_str must be a non-empty string", "MEMORY_INVALID_ARGUMENT");
    }
    if (typeof newStr !== "string") {
      throw new MemoryError("new_str must be a string", "MEMORY_INVALID_ARGUMENT");
    }
    return this.#run(async () => {
      const current = await this.#readText(relativePath);
      const occurrences = current.content.split(oldStr).length - 1;
      if (occurrences === 0) {
        throw new MemoryError("old_str was not found; read the file again before editing", "MEMORY_NO_MATCH");
      }
      if (occurrences > 1) {
        throw new MemoryError(
          `old_str occurs ${occurrences} times; include more surrounding text so it is unique`,
          "MEMORY_MULTIPLE_MATCHES"
        );
      }
      const next = current.content.replace(oldStr, () => newStr);
      this.#assertWithinFileBudget(relativePath, next);
      const written = await this.#atomicWrite(relativePath, next);
      return { path: virtual(relativePath), ...written, ...(await this.#syncIndex(relativePath, current.content, next)) };
    });
  }

  /**
   * Insert text at a zero-based line index. Like `strReplace`, it refreshes a
   * topic file's index line that still matches the old frontmatter.
   *
   * @param {string} relativePath - file path.
   * @param {number} line - 0-based line index, from 0 through the line count.
   * @param {string} text - text inserted as lines.
   * @returns {Promise<object>} written file metadata plus optional index status.
   */
  async insert(relativePath, line, text) {
    this.#assertFile(relativePath);
    if (!Number.isSafeInteger(line) || line < 0) {
      throw new MemoryError("insert_line must be a non-negative integer", "MEMORY_INVALID_ARGUMENT");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new MemoryError("insert_text must be a non-empty string", "MEMORY_INVALID_ARGUMENT");
    }
    return this.#run(async () => {
      const current = await this.#readText(relativePath);
      const lines = current.content.split("\n");
      const at = Math.min(line, lines.length);
      lines.splice(at, 0, ...text.split("\n"));
      const next = lines.join("\n");
      this.#assertWithinFileBudget(relativePath, next);
      const written = await this.#atomicWrite(relativePath, next);
      return {
        path: virtual(relativePath),
        ...written,
        insertedAt: at,
        ...(await this.#syncIndex(relativePath, current.content, next))
      };
    });
  }

  /**
   * Delete one file. Deleting a topic file also removes index lines that link it.
   *
   * @param {string} relativePath - file path.
   * @returns {Promise<object>} deletion metadata.
   */
  async delete(relativePath) {
    this.#assertFile(relativePath);
    return this.#run(async () => {
      const absolutePath = this.#absolute(relativePath);
      await this.#assertSafeAncestors(relativePath);
      const info = await this.#lstat(absolutePath);
      if (info === undefined) {
        throw new MemoryError(`${virtual(relativePath)} does not exist`, "MEMORY_NOT_FOUND");
      }
      if (info.isSymbolicLink()) {
        throw new MemoryError(`${virtual(relativePath)} is a symbolic link`, "MEMORY_SYMLINK");
      }
      if (!info.isFile()) {
        throw new MemoryError(`${virtual(relativePath)} is not a file`, "MEMORY_NOT_A_FILE");
      }
      await rm(absolutePath);
      let indexWarning;
      let indexed = false;
      if (relativePath !== INDEX_FILE) {
        try {
          indexed = await this.#unlinkIndex(relativePath);
        } catch (error) {
          indexWarning = `deleted the file, but could not update MEMORY.md: ${error.message}`;
        }
      }
      return { path: virtual(relativePath), changed: true, indexed, indexWarning };
    });
  }

  /**
   * Rename one file. Links in the index follow the file.
   *
   * @param {string} oldPath - existing file path.
   * @param {string} newPath - new file path.
   * @returns {Promise<object>} rename metadata.
   */
  async rename(oldPath, newPath) {
    this.#assertFile(oldPath);
    this.#assertFile(newPath);
    if (oldPath === INDEX_FILE || newPath === INDEX_FILE) {
      throw new MemoryError("MEMORY.md is the index and cannot be renamed; edit it in place", "MEMORY_INVALID_ARGUMENT");
    }
    return this.#run(async () => {
      const absoluteOld = this.#absolute(oldPath);
      const absoluteNew = this.#absolute(newPath);
      await this.#assertSafeAncestors(oldPath);
      await this.#assertSafeAncestors(newPath);
      const oldInfo = await this.#lstat(absoluteOld);
      if (oldInfo === undefined) {
        throw new MemoryError(`${virtual(oldPath)} does not exist`, "MEMORY_NOT_FOUND");
      }
      if (oldInfo.isSymbolicLink()) {
        throw new MemoryError(`${virtual(oldPath)} is a symbolic link`, "MEMORY_SYMLINK");
      }
      if (!oldInfo.isFile()) {
        throw new MemoryError(`${virtual(oldPath)} is not a file`, "MEMORY_NOT_A_FILE");
      }
      if (await this.#lstat(absoluteNew)) {
        throw new MemoryError(`${virtual(newPath)} already exists`, "MEMORY_ALREADY_EXISTS");
      }
      await mkdir(dirname(absoluteNew), { recursive: true });
      await renameFile(absoluteOld, absoluteNew);
      let indexWarning;
      let indexed = false;
      try {
        indexed = await this.#relinkIndex(oldPath, newPath);
      } catch (error) {
        indexWarning = `renamed the file, but could not update MEMORY.md: ${error.message}`;
      }
      return { path: virtual(newPath), previousPath: virtual(oldPath), changed: true, indexed, indexWarning };
    });
  }

  #indexFields(relativePath, text) {
    const parsed = parseMemory(text ?? "");
    const title = parsed.name ?? basename(relativePath, extname(relativePath));
    const firstLine = parsed.body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("<!--"));
    const hook = (parsed.description ?? firstLine ?? "")
      .replace(/^#+\s*/u, "")
      .replace(/\s+/gu, " ")
      .slice(0, 110);
    return { title, hook };
  }

  #indexEntry(relativePath, text) {
    const { title, hook } = this.#indexFields(relativePath, text);
    return `- [${title}](${relativePath})${hook.length > 0 ? ` — ${hook}` : ""}`;
  }

  /**
   * Refresh the index line of an edited topic file. A title or hook is
   * replaced only while it still equals what the old content would have
   * generated, so a line the model rewrote by hand is left alone.
   */
  async #syncIndex(relativePath, before, after) {
    if (relativePath === INDEX_FILE) return {};
    const previous = this.#indexFields(relativePath, before);
    const current = this.#indexFields(relativePath, after);
    if (previous.title === current.title && previous.hook === current.hook) return {};
    try {
      const index = await this.index();
      if (!index.exists) return { indexed: false };
      const link = `](${relativePath})`;
      let changed = false;
      const lines = index.content.split("\n").map((line) => {
        const at = line.indexOf(link);
        const open = line.lastIndexOf("[", at);
        if (at === -1 || open === -1 || !/^\s*-\s*$/u.test(line.slice(0, open))) return line;
        const title = line.slice(open + 1, at);
        const rest = line.slice(at + link.length);
        const hook = rest.startsWith(" — ") ? rest.slice(3) : rest.length === 0 ? "" : undefined;
        if (hook === undefined) return line;
        const nextTitle = title === previous.title ? current.title : title;
        const nextHook = hook === previous.hook ? current.hook : hook;
        if (nextTitle === title && nextHook === hook) return line;
        changed = true;
        return `${line.slice(0, open)}[${nextTitle}${link}${nextHook.length > 0 ? ` — ${nextHook}` : ""}`;
      });
      if (!changed) return { indexed: false };
      const next = lines.join("\n");
      if (byteLength(next) > this.maxFileBytes) {
        throw new MemoryError("MEMORY.md is full; remove or merge entries before adding more", "MEMORY_INDEX_FULL");
      }
      await this.#atomicWrite(INDEX_FILE, next);
      return { indexed: true };
    } catch (error) {
      return { indexed: false, indexWarning: `edited the file, but could not update MEMORY.md: ${error.message}` };
    }
  }

  async #linkIndex(relativePath, text) {
    const index = await this.index();
    const link = `](${relativePath})`;
    if (index.exists && index.content.includes(link)) return { updated: false };
    const entry = this.#indexEntry(relativePath, text);
    const next = index.exists
      ? `${index.content.replace(/\n*$/u, "")}\n${entry}\n`
      : `${INDEX_HEADER.replace(/\n*$/u, "")}\n\n${entry}\n`;
    if (byteLength(next) > this.maxFileBytes) {
      throw new MemoryError("MEMORY.md is full; remove or merge entries before adding more", "MEMORY_INDEX_FULL");
    }
    await this.#atomicWrite(INDEX_FILE, next);
    return { updated: true };
  }

  async #unlinkIndex(relativePath) {
    const index = await this.index();
    if (!index.exists) return false;
    const needle = `](${relativePath})`;
    const lines = index.content.split("\n");
    const kept = lines.filter((line) => !line.includes(needle));
    if (kept.length === lines.length) return false;
    const next = kept.join("\n");
    await this.#atomicWrite(INDEX_FILE, next);
    return true;
  }

  async #relinkIndex(oldPath, newPath) {
    const index = await this.index();
    if (!index.exists) return false;
    const needle = `](${oldPath})`;
    if (!index.content.includes(needle)) return false;
    const next = index.content.split(needle).join(`](${newPath})`);
    await this.#atomicWrite(INDEX_FILE, next);
    return true;
  }
}
