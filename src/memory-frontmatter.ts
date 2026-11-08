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
 * a top-level `type` (and `modified`) is accepted as a fallback. Anything
 * unparsable yields no fields, so a malformed file still loads as plain text.
 */

const DELIMITER = "---";

/** Memory types, mirroring Claude Code's memory taxonomy. */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Memory names share DSH's skill-name shape so `[[name]]` maps to `name.md`. */
export const MEMORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** One parsed memory file. */
export interface ParsedMemory {
  frontmatter: boolean;
  name?: string;
  description?: string;
  type?: string;
  modified?: string;
  body: string;
}

/** One stable frontmatter problem code plus a readable message. */
export interface MemoryIssue {
  code: string;
  message: string;
}

function scalar(value: string): string {
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
 */
export function parseMemory(content: string): ParsedMemory {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== DELIMITER) return { frontmatter: false, body: source };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (end === -1) return { frontmatter: false, body: source };

  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
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

  const result: ParsedMemory = {
    frontmatter: true,
    body: lines.slice(end + 1).join("\n").replace(/^\n+/u, "")
  };
  const name = top.name;
  const description = top.description;
  const type = metadata.type ?? top.type;
  const modified = metadata.modified ?? top.modified;
  if (name !== undefined && name.length > 0) result.name = name;
  if (description !== undefined && description.length > 0) result.description = description;
  if (type !== undefined && type.length > 0) result.type = type;
  if (modified !== undefined && modified.length > 0) result.modified = modified;
  return result;
}

/**
 * Describe each frontmatter problem as a stable code plus a readable message.
 *
 * Codes stay stable when only the offending value changes, so callers can tell
 * "the same problem still exists" from "this edit introduced a new problem".
 */
export function memoryFrontmatterIssues(
  parsed: ParsedMemory,
  fileStem?: string,
  filePath?: string
): MemoryIssue[] {
  if (!parsed.frontmatter) {
    return [{ code: "frontmatter-missing", message: "no frontmatter (name, description, metadata.type)" }];
  }

  const issues: MemoryIssue[] = [];
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
  } else if (!(MEMORY_TYPES as readonly string[]).includes(parsed.type)) {
    issues.push({
      code: "type-invalid",
      message: `metadata.type ${JSON.stringify(parsed.type)} is not one of ${MEMORY_TYPES.join(", ")}`
    });
  }
  return issues;
}

/**
 * List what a topic file's frontmatter is missing, for a non-blocking hint.
 */
export function memoryFrontmatterProblems(
  parsed: ParsedMemory,
  fileStem?: string,
  filePath?: string
): string[] {
  return memoryFrontmatterIssues(parsed, fileStem, filePath).map((issue) => issue.message);
}

/**
 * Record the write time in a `modified` frontmatter field.
 *
 * Claude Code records an ISO 8601 timestamp when it writes a memory file that
 * begins with YAML frontmatter. A file without frontmatter is left untouched;
 * an existing top-level or `metadata.modified` value is replaced in place, and
 * a `metadata.modified` value is added only when a `metadata:` block exists.
 * Line endings and every other line are preserved.
 */
export function touchModified(content: string, now: Date = new Date()): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom.length > 0 ? content.slice(1) : content;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== DELIMITER) return content;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === DELIMITER) {
      end = index;
      break;
    }
  }
  if (end === -1) return content;

  const timestamp = now.toISOString();
  const frontmatter = lines.slice(1, end);
  let topModified = -1;
  let metadataStart = -1;
  let metadataEnd = -1;
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index];
    if (topModified === -1 && /^modified\s*:/u.test(line)) topModified = index;
    if (metadataStart === -1 && /^metadata\s*:\s*$/u.test(line)) metadataStart = index;
  }
  if (metadataStart !== -1) {
    metadataEnd = metadataStart + 1;
    while (metadataEnd < frontmatter.length) {
      const line = frontmatter[metadataEnd];
      if (line.trim().length === 0) break;
      if (!/^\s+/u.test(line)) break;
      metadataEnd += 1;
    }
  }

  let nestedModified = -1;
  if (metadataStart !== -1) {
    for (let index = metadataStart + 1; index < metadataEnd; index += 1) {
      if (/^\s+modified\s*:/u.test(frontmatter[index])) {
        nestedModified = index;
        break;
      }
    }
  }

  const replaceValue = (line: string): string => {
    const prefix = /^(\s*modified\s*:).*$/u.exec(line);
    return prefix === null ? line : `${prefix[1]} ${timestamp}`;
  };

  if (topModified !== -1) {
    frontmatter[topModified] = replaceValue(frontmatter[topModified]);
  }
  if (nestedModified !== -1) {
    frontmatter[nestedModified] = replaceValue(frontmatter[nestedModified]);
  }
  if (nestedModified === -1 && metadataStart !== -1) {
    frontmatter.splice(metadataStart + 1, 0, `  modified: ${timestamp}`);
  }
  if (topModified === -1 && metadataStart === -1) {
    frontmatter.push(`modified: ${timestamp}`);
  }

  const next = [lines[0], ...frontmatter, ...lines.slice(end)].join(eol);
  return `${bom}${next}`;
}
