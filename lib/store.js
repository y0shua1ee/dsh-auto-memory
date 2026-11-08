import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename as renameFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { MEMORY_NAME, memoryFrontmatterIssues, parseMemory, touchModified } from "./memory-frontmatter.js";
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
/** Safety cap for reading and rewriting the index; the injected budget is separate. */
const MAX_INDEX_SOURCE_BYTES = 4 * 1024 * 1024;
const NEAR_LIMIT_LINES = 10;
const NEAR_LIMIT_RATIO = 0.9;
const SAFE_SEGMENT = /^[^\\/\u0000-\u001f\u007f:*?"<>|#%[\]()]+$/u;
const INDEX_BULLET = /^(\s*[-*]\s*)/u;
const CHECKBOX = /^\s*(?:[xX])?\s*$/u;
/** A memory operation failed with a model-actionable reason. */
export class MemoryError extends Error {
    code;
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
function needsAngle(target) {
    return /\s/u.test(target);
}
/**
 * Read a Markdown link destination. A destination with whitespace is written
 * as `<target>`; the bare form is kept for older index lines and for targets
 * without whitespace.
 */
function readTarget(line, start) {
    if (line[start] === "<") {
        const close = line.indexOf(">", start + 1);
        if (close === -1 || line[close + 1] !== ")")
            return undefined;
        return { target: line.slice(start + 1, close), end: close + 2 };
    }
    const close = line.indexOf(")", start);
    if (close === -1)
        return undefined;
    return { target: line.slice(start, close), end: close + 1 };
}
/**
 * Find the title of the first link, matching nested brackets. This keeps a
 * link embedded in a title from becoming the entry target.
 */
function leadingLink(line, open) {
    let depth = 0;
    for (let index = open; index < line.length; index += 1) {
        const char = line[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "[") {
            depth += 1;
        }
        else if (char === "]") {
            depth -= 1;
            if (depth === 0) {
                if (line[index + 1] !== "(")
                    return undefined;
                return { title: line.slice(open + 1, index), targetStart: index + 2 };
            }
        }
    }
    return undefined;
}
/**
 * Parse one index line that links `target`. Only the leading link counts, so
 * links inside a hook never identify the line. A line whose title contains
 * nested brackets is handled by bracket matching; v0.3.0 wrote unescaped
 * names as titles, so a malformed legacy title can still be recognized by the
 * first link after the opening `[`.
 */
function parseIndexLine(line, target) {
    const cr = line.endsWith("\r") ? "\r" : "";
    const text = cr.length > 0 ? line.slice(0, -1) : line;
    const bullet = INDEX_BULLET.exec(text);
    if (bullet === null)
        return undefined;
    const prefix = bullet[1];
    const open = prefix.length;
    if (text[open] !== "[")
        return undefined;
    const leading = leadingLink(text, open);
    if (leading !== undefined) {
        const destination = readTarget(text, leading.targetStart);
        if (destination === undefined || destination.target !== target)
            return undefined;
        return {
            bullet: prefix,
            title: leading.title,
            target: destination.target,
            rest: text.slice(destination.end),
            cr
        };
    }
    // `- [ ] [name](target)` is a task list, not an index line.
    const firstClose = text.indexOf("]", open + 1);
    if (firstClose !== -1) {
        const box = text.slice(open + 1, firstClose);
        if (CHECKBOX.test(box) && text.indexOf("[", firstClose + 1) !== -1)
            return undefined;
        if (text.slice(firstClose + 1).trimStart().startsWith("["))
            return undefined;
    }
    // A legacy title such as `- [a]b](target)` lacks a bracket before the
    // destination; fall back to the first link, which is still the entry link.
    const firstLink = text.indexOf("](", open + 1);
    if (firstLink === -1)
        return undefined;
    const hookAt = text.indexOf(" — ", open + 1);
    if (hookAt !== -1 && firstLink > hookAt)
        return undefined;
    const destination = readTarget(text, firstLink + 2);
    if (destination === undefined || destination.target !== target)
        return undefined;
    return {
        bullet: prefix,
        title: text.slice(open + 1, firstLink),
        target: destination.target,
        rest: text.slice(destination.end),
        cr
    };
}
function formatIndexLine({ bullet, title, target, rest, cr }) {
    const destination = needsAngle(target) ? `<${target}>` : target;
    return `${bullet}[${title}](${destination})${rest}${cr}`;
}
function stem(relativePath) {
    return basename(relativePath, extname(relativePath));
}
function frontmatterIssues(relativePath, content) {
    return memoryFrontmatterIssues(parseMemory(content), stem(relativePath), relativePath);
}
/** Frontmatter problems present after an edit or rename that were not present before it. */
function introducedProblems(relativePath, before, after, previousPath = relativePath) {
    if (relativePath === INDEX_FILE)
        return [];
    const known = new Set(frontmatterIssues(previousPath, before).map((issue) => issue.code));
    return frontmatterIssues(relativePath, after)
        .filter((issue) => !known.has(issue.code))
        .map((issue) => issue.message);
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
    root;
    maxFileBytes;
    maxIndexBytes;
    maxIndexLines;
    maxFiles;
    #queue = Promise.resolve();
    constructor({ root, maxFileBytes, maxIndexBytes, maxIndexLines = 200, maxFiles }) {
        this.root = resolve(root);
        this.maxFileBytes = maxFileBytes;
        this.maxIndexBytes = maxIndexBytes;
        this.maxIndexLines = maxIndexLines;
        this.maxFiles = maxFiles;
    }
    /** Run one mutation after every earlier mutation and return its result. */
    #run(operation) {
        const result = this.#queue.then(operation, operation);
        this.#queue = result.then(() => undefined, () => undefined);
        return result;
    }
    /**
     * Parse a model-supplied virtual path.
     *
     * @param value - path such as `/memories/MEMORY.md`.
     * @returns project-relative path, or `''` for the root.
     */
    static parseVirtualPath(value) {
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new MemoryError("path is required and must be a string", "MEMORY_INVALID_PATH");
        }
        const raw = value.trim();
        if (raw === VIRTUAL_ROOT || raw === `${VIRTUAL_ROOT}/`)
            return "";
        if (!raw.startsWith(`${VIRTUAL_ROOT}/`)) {
            throw new MemoryError(`path must start with ${VIRTUAL_ROOT} (received ${JSON.stringify(value)})`, "MEMORY_INVALID_PATH");
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
                throw new MemoryError(`path segment ${JSON.stringify(segment)} contains unsupported characters`, "MEMORY_INVALID_PATH");
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
    #readLimit(relativePath) {
        return relativePath === INDEX_FILE ? MAX_INDEX_SOURCE_BYTES : this.maxFileBytes;
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
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT" || code === "ENOTDIR")
                return undefined;
            throw error;
        }
    }
    async #assertSafeAncestors(relativePath) {
        const segments = relativePath.split("/").slice(0, -1);
        let current = this.root;
        for (const segment of segments) {
            current = join(current, segment);
            const info = await this.#lstat(current);
            if (info === undefined)
                return;
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
            throw new MemoryError(`${virtual(relativePath)} is ${info.size} bytes, above the ${limit}-byte read limit`, "MEMORY_TOO_LARGE");
        }
        const content = await readFile(absolutePath, "utf8");
        if (Buffer.byteLength(content, "utf8") > limit) {
            throw new MemoryError(`${virtual(relativePath)} grew above the ${limit}-byte read limit`, "MEMORY_TOO_LARGE");
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
        }
        catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
        return { bytes: byteLength(content), lines: lineCount(content) };
    }
    #assertWithinFileBudget(relativePath, content) {
        const bytes = byteLength(content);
        if (relativePath === INDEX_FILE) {
            if (bytes > MAX_INDEX_SOURCE_BYTES) {
                throw new MemoryError(`${INDEX_FILE} would be ${bytes} bytes, above the ${MAX_INDEX_SOURCE_BYTES}-byte safety limit; rewrite the index`, "MEMORY_INDEX_FULL");
            }
            return bytes;
        }
        if (bytes > this.maxFileBytes) {
            throw new MemoryError(`${virtual(relativePath)} would be ${bytes} bytes, above the ${this.maxFileBytes}-byte limit; split it into topic files`, "MEMORY_TOO_LARGE");
        }
        return bytes;
    }
    async #list(relativePath) {
        const absolutePath = this.#absolute(relativePath);
        await this.#assertSafeAncestors(relativePath);
        const info = await this.#lstat(absolutePath);
        if (info === undefined) {
            if (relativePath.length === 0)
                return [];
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
            if (depth > MAX_LIST_DEPTH)
                return;
            const children = await readdir(directory, { withFileTypes: true });
            children.sort((left, right) => left.name.localeCompare(right.name));
            for (const child of children) {
                if (child.name.startsWith("."))
                    continue;
                const childAbsolute = join(directory, child.name);
                const childRelative = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
                const childInfo = await this.#lstat(childAbsolute);
                if (childInfo === undefined || childInfo.isSymbolicLink())
                    continue;
                if (childInfo.isDirectory()) {
                    entries.push({ path: virtual(childRelative), kind: "directory", bytes: 0 });
                    await walk(childAbsolute, childRelative, depth + 1);
                }
                else if (childInfo.isFile()) {
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
     */
    async index() {
        const absolutePath = this.#absolute(INDEX_FILE);
        const info = await this.#lstat(absolutePath);
        if (info === undefined)
            return { exists: false };
        if (info.isSymbolicLink()) {
            throw new MemoryError(`${INDEX_FILE} is a symbolic link`, "MEMORY_SYMLINK");
        }
        if (!info.isFile())
            return { exists: false };
        if (info.size > MAX_INDEX_SOURCE_BYTES) {
            const handle = await open(absolutePath, "r");
            try {
                const buffer = Buffer.alloc(MAX_INDEX_SOURCE_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                const content = buffer.subarray(0, bytesRead).toString("utf8");
                if (content.includes("\0")) {
                    throw new MemoryError(`${INDEX_FILE} is not a text file`, "MEMORY_NOT_A_FILE");
                }
                return {
                    exists: true,
                    content,
                    bytes: info.size,
                    mtimeMs: info.mtimeMs,
                    truncated: true
                };
            }
            finally {
                await handle.close();
            }
        }
        const content = await readFile(absolutePath, "utf8");
        if (Buffer.byteLength(content, "utf8") > MAX_INDEX_SOURCE_BYTES) {
            throw new MemoryError(`${INDEX_FILE} grew above the ${MAX_INDEX_SOURCE_BYTES}-byte read limit`, "MEMORY_TOO_LARGE");
        }
        if (content.includes("\0")) {
            throw new MemoryError(`${INDEX_FILE} is not a text file`, "MEMORY_NOT_A_FILE");
        }
        return { exists: true, content, bytes: info.size, mtimeMs: info.mtimeMs, truncated: false };
    }
    /**
     * Compare the index against the 200-line and 25KB injection budget.
     *
     * The budget is a read limit, not a hard write limit: a write may leave the
     * index over budget, but the caller must tell the model to rewrite it because
     * everything past the limit is dropped on the next load.
     */
    indexBudget(content, truncated = false) {
        const lines = lineCount(content);
        const bytes = byteLength(content);
        const reasons = [];
        if (lines > this.maxIndexLines)
            reasons.push("lines");
        if (bytes > this.maxIndexBytes)
            reasons.push("bytes");
        if (truncated)
            reasons.push("source");
        const overLimit = reasons.length > 0;
        const nearLimit = !overLimit &&
            (this.maxIndexLines - lines <= NEAR_LIMIT_LINES ||
                bytes >= Math.floor(this.maxIndexBytes * NEAR_LIMIT_RATIO));
        return {
            lines,
            bytes,
            lineLimit: this.maxIndexLines,
            byteLimit: this.maxIndexBytes,
            overLimit,
            nearLimit,
            reasons
        };
    }
    async #checkIndexBudget() {
        const index = await this.index();
        if (!index.exists)
            return {};
        const budget = this.indexBudget(index.content, index.truncated);
        if (budget.overLimit) {
            const where = `${INDEX_FILE} is now ${budget.lines} lines / ${budget.bytes} bytes, over its ${budget.lineLimit}-line / ${budget.byteLimit}-byte read limit`;
            throw new MemoryError(`${where}. The change was applied. Rewrite the index: keep one line per memory, move detail into topic files, and merge or drop stale entries.`, "MEMORY_INDEX_OVER_LIMIT");
        }
        return {
            indexBudget: budget,
            ...(budget.nearLimit
                ? {
                    indexBudgetWarning: `${INDEX_FILE} is near its read limit at ${budget.lines}/${budget.lineLimit} lines and ` +
                        `${budget.bytes}/${budget.byteLimit} bytes; keep one line per memory, move detail into topic files, ` +
                        "and merge or drop stale entries."
                }
                : {})
        };
    }
    /**
     * List the root or one subtree.
     */
    async list(relativePath = "") {
        return this.#list(relativePath);
    }
    /**
     * Read one file or list one directory.
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
        const read = await this.#readText(relativePath, this.#readLimit(relativePath));
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
                throw new MemoryError(`memory already holds ${this.maxFiles} files; delete or merge some before creating another`, "MEMORY_TOO_MANY_FILES");
            }
            const content = typeof text === "string" ? text : "";
            const next = relativePath === INDEX_FILE
                ? content.trim().length === 0
                    ? INDEX_HEADER
                    : content
                : touchModified(content);
            this.#assertWithinFileBudget(relativePath, next);
            const written = await this.#atomicWrite(relativePath, next);
            let indexWarning;
            let indexed = false;
            let frontmatterProblems = [];
            if (relativePath !== INDEX_FILE) {
                frontmatterProblems = frontmatterIssues(relativePath, next).map((issue) => issue.message);
                try {
                    indexed = (await this.#linkIndex(relativePath, next)).updated;
                }
                catch (error) {
                    indexWarning = `created the file, but could not update MEMORY.md: ${error.message}`;
                }
            }
            const budget = await this.#checkIndexBudget();
            return {
                path: virtual(relativePath),
                ...written,
                indexed,
                indexWarning,
                ...budget,
                frontmatterProblems
            };
        });
    }
    /**
     * Replace exactly one occurrence of `oldStr`. Editing a topic file also
     * refreshes its index line when that line still matches the old frontmatter.
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
            const current = await this.#readText(relativePath, this.#readLimit(relativePath));
            const occurrences = current.content.split(oldStr).length - 1;
            if (occurrences === 0) {
                throw new MemoryError("old_str was not found; read the file again before editing", "MEMORY_NO_MATCH");
            }
            if (occurrences > 1) {
                throw new MemoryError(`old_str occurs ${occurrences} times; include more surrounding text so it is unique`, "MEMORY_MULTIPLE_MATCHES");
            }
            const next = current.content.replace(oldStr, () => newStr);
            const stamped = relativePath === INDEX_FILE ? next : touchModified(next);
            this.#assertWithinFileBudget(relativePath, stamped);
            const written = await this.#atomicWrite(relativePath, stamped);
            const sync = await this.#syncIndex(relativePath, current.content, stamped);
            const budget = await this.#checkIndexBudget();
            return {
                path: virtual(relativePath),
                ...written,
                ...sync,
                ...budget,
                frontmatterProblems: introducedProblems(relativePath, current.content, stamped)
            };
        });
    }
    /**
     * Insert text at a zero-based line index. Like `strReplace`, it refreshes a
     * topic file's index line that still matches the old frontmatter.
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
            const current = await this.#readText(relativePath, this.#readLimit(relativePath));
            const lines = current.content.split("\n");
            const at = Math.min(line, lines.length);
            lines.splice(at, 0, ...text.split("\n"));
            const next = lines.join("\n");
            const stamped = relativePath === INDEX_FILE ? next : touchModified(next);
            this.#assertWithinFileBudget(relativePath, stamped);
            const written = await this.#atomicWrite(relativePath, stamped);
            const sync = await this.#syncIndex(relativePath, current.content, stamped);
            const budget = await this.#checkIndexBudget();
            return {
                path: virtual(relativePath),
                ...written,
                insertedAt: at,
                ...sync,
                ...budget,
                frontmatterProblems: introducedProblems(relativePath, current.content, stamped)
            };
        });
    }
    /**
     * Delete one file. Deleting a topic file also removes index lines that link it.
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
                }
                catch (error) {
                    indexWarning = `deleted the file, but could not update MEMORY.md: ${error.message}`;
                }
            }
            const budget = await this.#checkIndexBudget();
            return { path: virtual(relativePath), changed: true, indexed, indexWarning, ...budget };
        });
    }
    /**
     * Rename one file. Links in the index follow the file, and a title still
     * generated from the old file name follows the new one.
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
            const content = await this.#readText(oldPath, this.#readLimit(oldPath)).then((read) => read.content, () => undefined);
            await mkdir(dirname(absoluteNew), { recursive: true });
            await renameFile(absoluteOld, absoluteNew);
            let indexWarning;
            let indexed = false;
            const previousFields = this.#indexFields(oldPath, content);
            const nextFields = this.#indexFields(newPath, content);
            try {
                indexed = await this.#rewriteIndex(oldPath, (entry) => ({
                    ...entry,
                    target: newPath,
                    title: entry.title === previousFields.title || entry.title === previousFields.legacyTitle
                        ? nextFields.title
                        : entry.title
                }));
            }
            catch (error) {
                indexWarning = `renamed the file, but could not update MEMORY.md: ${error.message}`;
            }
            const frontmatterProblems = content === undefined ? [] : introducedProblems(newPath, content, content, oldPath);
            const budget = await this.#checkIndexBudget();
            return {
                path: virtual(newPath),
                previousPath: virtual(oldPath),
                changed: true,
                indexed,
                indexWarning,
                ...budget,
                frontmatterProblems
            };
        });
    }
    #indexFields(relativePath, text) {
        const parsed = parseMemory(text ?? "");
        const title = parsed.name !== undefined && MEMORY_NAME.test(parsed.name) ? parsed.name : stem(relativePath);
        const firstLine = parsed.body
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0 && !line.startsWith("<!--"));
        const hook = (parsed.description ?? firstLine ?? "")
            .replace(/^#+\s*/u, "")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 110);
        return { title, hook, legacyTitle: parsed.name };
    }
    #indexEntry(relativePath, text) {
        const { title, hook } = this.#indexFields(relativePath, text);
        return formatIndexLine({
            bullet: "- ",
            title,
            target: relativePath,
            rest: hook.length > 0 ? ` — ${hook}` : "",
            cr: ""
        });
    }
    /**
     * Rewrite the index lines that link `relativePath`.
     *
     * @param update - returns the replacement entry, `null` to drop the line, or
     *   `undefined` to keep it.
     * @returns whether the index changed.
     */
    async #rewriteIndex(relativePath, update) {
        const index = await this.index();
        if (!index.exists)
            return false;
        if (index.truncated) {
            throw new MemoryError(`${INDEX_FILE} is too large to rewrite; rewrite the index before editing more entries`, "MEMORY_INDEX_FULL");
        }
        let changed = false;
        const lines = [];
        for (const line of index.content.split("\n")) {
            const entry = parseIndexLine(line, relativePath);
            const next = entry === undefined ? undefined : update(entry);
            if (next === undefined) {
                lines.push(line);
            }
            else if (next !== null) {
                const formatted = formatIndexLine(next);
                changed ||= formatted !== line;
                lines.push(formatted);
            }
            else {
                changed = true;
            }
        }
        if (!changed)
            return false;
        const content = lines.join("\n");
        if (byteLength(content) > MAX_INDEX_SOURCE_BYTES) {
            throw new MemoryError("MEMORY.md is too large to rewrite; remove or merge entries before adding more", "MEMORY_INDEX_FULL");
        }
        await this.#atomicWrite(INDEX_FILE, content);
        return true;
    }
    /**
     * Refresh the index line of an edited topic file. A title or hook is replaced
     * only while it still equals what the old content would have generated, so a
     * line the model rewrote by hand is left alone. An invalid name from v0.3.0
     * was used as the title then; it is recognized as the legacy generated title
     * and normalized to the current fallback.
     */
    async #syncIndex(relativePath, before, after) {
        if (relativePath === INDEX_FILE)
            return {};
        const previous = this.#indexFields(relativePath, before);
        const current = this.#indexFields(relativePath, after);
        const legacyStale = previous.legacyTitle !== undefined && previous.legacyTitle !== previous.title;
        if (previous.title === current.title && previous.hook === current.hook && !legacyStale)
            return {};
        try {
            const indexed = await this.#rewriteIndex(relativePath, (entry) => {
                const hook = entry.rest.startsWith(" — ") ? entry.rest.slice(3) : entry.rest.length === 0 ? "" : undefined;
                if (hook === undefined)
                    return undefined;
                const title = entry.title === previous.title || entry.title === previous.legacyTitle
                    ? current.title
                    : entry.title;
                const nextHook = hook === previous.hook ? current.hook : hook;
                return { ...entry, title, rest: nextHook.length > 0 ? ` — ${nextHook}` : "" };
            });
            return { indexed };
        }
        catch (error) {
            return { indexed: false, indexWarning: `edited the file, but could not update MEMORY.md: ${error.message}` };
        }
    }
    async #linkIndex(relativePath, text) {
        const index = await this.index();
        if (index.exists && index.truncated) {
            throw new MemoryError(`${INDEX_FILE} is too large to rewrite; rewrite the index before adding more entries`, "MEMORY_INDEX_FULL");
        }
        if (index.exists &&
            index.content.split("\n").some((line) => parseIndexLine(line, relativePath) !== undefined)) {
            return { updated: false };
        }
        const entry = this.#indexEntry(relativePath, text);
        let next;
        if (!index.exists || index.content.trim().length === 0) {
            next = `${INDEX_HEADER.replace(/\n*$/u, "")}\n\n${entry}\n`;
        }
        else {
            const content = index.content.replace(/[ \t]+$/u, "");
            const eol = content.endsWith("\r\n") ? "\r\n" : content.endsWith("\r") ? "\r" : "\n";
            const separator = content.length === 0 || content.endsWith("\n") || content.endsWith("\r") ? "" : eol;
            next = `${content}${separator}${entry}${eol}`;
        }
        if (byteLength(next) > MAX_INDEX_SOURCE_BYTES) {
            throw new MemoryError("MEMORY.md is too large to rewrite; remove or merge entries before adding more", "MEMORY_INDEX_FULL");
        }
        await this.#atomicWrite(INDEX_FILE, next);
        return { updated: true };
    }
    async #unlinkIndex(relativePath) {
        return this.#rewriteIndex(relativePath, () => null);
    }
}
