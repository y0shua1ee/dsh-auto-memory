/**
 * Parse the frontmatter of one memory file, in the shape Claude Code uses:
 *
 * ```markdown
 * ---
 * name: prefer-pnpm
 * description: The user wants pnpm, never npm, in this repo
 * metadata:
 *   type: feedback
 * ---
 * ```
 *
 * Only flat `key: value` scalars and the one-level `metadata:` block are read;
 * a top-level `type` is accepted as a fallback. Anything unparsable yields no
 * fields, so a malformed file still loads as plain text.
 */

const DELIMITER = "---";

/** Memory types, mirroring Claude Code's memory taxonomy. */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

/** Memory names share DSH's skill-name shape so `[[name]]` maps to `name.md`. */
export const MEMORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function scalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Read a memory file's frontmatter fields and body.
 *
 * @param {string} content - complete memory file text.
 * @returns {{frontmatter: boolean, name?: string, description?: string, type?: string, body: string}}
 */
export function parseMemory(content) {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== DELIMITER) return { frontmatter: false, body: source };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (end === -1) return { frontmatter: false, body: source };

  const top = {};
  const metadata = {};
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const match = /^(\s*)([A-Za-z_][\w-]*)\s*:(.*)$/u.exec(line);
    if (match === null) continue;
    const [, indent, key, rest] = match;
    if (indent.length === 0) {
      inMetadata = key === "metadata" && rest.trim().length === 0;
      if (!inMetadata) top[key] = scalar(rest);
    } else if (inMetadata) {
      metadata[key] = scalar(rest);
    }
  }

  const result = { frontmatter: true, body: lines.slice(end + 1).join("\n").replace(/^\n+/u, "") };
  for (const [field, value] of [
    ["name", top.name],
    ["description", top.description],
    ["type", metadata.type ?? top.type]
  ]) {
    if (value !== undefined && value.length > 0) result[field] = value;
  }
  return result;
}

/**
 * Describe each frontmatter problem as a stable code plus a readable message.
 *
 * Codes stay stable when only the offending value changes, so callers can tell
 * "the same problem still exists" from "this edit introduced a new problem".
 *
 * @param {ReturnType<typeof parseMemory>} parsed - parsed memory file.
 * @param {string} [fileStem] - file name without `.md`; `[[name]]` resolves to it.
 * @param {string} [filePath] - project-relative path, used to detect subdirectories.
 * @returns {Array<{code: string, message: string}>} problems; empty when well-formed.
 */
export function memoryFrontmatterIssues(parsed, fileStem, filePath) {
  if (!parsed.frontmatter) {
    return [{ code: "frontmatter-missing", message: "no frontmatter (name, description, metadata.type)" }];
  }

  const issues = [];
  if (parsed.name === undefined) {
    issues.push({ code: "name-missing", message: "missing name" });
  } else if (!MEMORY_NAME.test(parsed.name)) {
    issues.push({
      code: "name-invalid",
      message: `name ${JSON.stringify(parsed.name)} is not kebab-case`
    });
  } else if (fileStem !== undefined && parsed.name !== fileStem) {
    const file = filePath ?? `${fileStem}.md`;
    issues.push({
      code: "name-unmatched",
      message: `name ${JSON.stringify(parsed.name)} does not match the file name ${file}, so [[${parsed.name}]] will not resolve`
    });
  } else if (filePath !== undefined && filePath.includes("/")) {
    issues.push({
      code: "name-nested",
      message:
        `name ${JSON.stringify(parsed.name)} matches the file name, but the file is in a subdirectory; ` +
        `[[${parsed.name}]] resolves to /memories/${parsed.name}.md, not this file`
    });
  }

  if (parsed.description === undefined) {
    issues.push({ code: "description-missing", message: "missing description" });
  }
  if (parsed.type === undefined) {
    issues.push({ code: "type-missing", message: "missing metadata.type" });
  } else if (!MEMORY_TYPES.includes(parsed.type)) {
    issues.push({
      code: "type-invalid",
      message: `metadata.type ${JSON.stringify(parsed.type)} is not one of ${MEMORY_TYPES.join(", ")}`
    });
  }
  return issues;
}

/**
 * List what a topic file's frontmatter is missing, for a non-blocking hint.
 *
 * @param {ReturnType<typeof parseMemory>} parsed - parsed memory file.
 * @param {string} [fileStem] - file name without `.md`; `[[name]]` resolves to it.
 * @param {string} [filePath] - project-relative path, used to detect subdirectories.
 * @returns {string[]} human-readable problems; empty when the file is well-formed.
 */
export function memoryFrontmatterProblems(parsed, fileStem, filePath) {
  return memoryFrontmatterIssues(parsed, fileStem, filePath).map((issue) => issue.message);
}
