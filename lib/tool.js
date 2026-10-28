import { INDEX_FILE, MemoryError, MemoryStore, VIRTUAL_ROOT } from "./store.js";

const COMMANDS = ["view", "create", "str_replace", "insert", "delete", "rename"];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function requireString(value, name) {
  if (typeof value !== "string") {
    throw new MemoryError(`${name} is required and must be a string`, "MEMORY_INVALID_ARGUMENT");
  }
  return value;
}

function renderListing(relativePath, entries) {
  if (entries.length === 0) {
    return relativePath.length === 0
      ? `${VIRTUAL_ROOT} is empty. Create a memory file with memory create; it is indexed in ${VIRTUAL_ROOT}/${INDEX_FILE} automatically.`
      : `${VIRTUAL_ROOT}/${relativePath} is empty.`;
  }
  const files = entries.filter((entry) => entry.kind === "file");
  const bytes = files.reduce((total, entry) => total + entry.bytes, 0);
  const heading = relativePath.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${relativePath}`;
  const lines = [`${heading} (${files.length} ${files.length === 1 ? "file" : "files"}, ${formatBytes(bytes)})`];
  for (const entry of entries) {
    const suffix = entry.kind === "directory" ? "/" : ` (${formatBytes(entry.bytes)})`;
    lines.push(`- ${entry.path}${suffix}`);
  }
  return lines.join("\n");
}

function indexNote({ indexed, indexWarning, action }) {
  if (indexWarning !== undefined) return indexWarning;
  if (indexed) return `Updated MEMORY.md (${action}).`;
  return `MEMORY.md already links this file (${action}).`;
}

function editIndexNote({ indexed, indexWarning }) {
  if (indexWarning !== undefined) return [indexWarning];
  return indexed ? ["Updated its MEMORY.md line to match the new frontmatter."] : [];
}

async function viewToolOutput(store, relativePath, numbered) {
  const result = await store.view(relativePath);
  if (result.kind === "directory") {
    return {
      ok: true,
      output: renderListing(relativePath, result.entries),
      path: relativePath.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${relativePath}`,
      entries: result.entries
    };
  }
  const output = numbered
    ? result.content
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(4, " ")}: ${line}`)
        .join("\n")
    : result.content;
  return {
    ok: true,
    output,
    path: `${VIRTUAL_ROOT}/${relativePath}`,
    bytes: result.bytes,
    lines: result.lines
  };
}

/**
 * Build the `memory` tool definition options.
 *
 * The returned object is passed to `defineTool` by the plugin entry. Keeping it
 * free of `defineTool` imports lets the command semantics be tested without a
 * running harness.
 *
 * @param {object} input - tool wiring.
 * @param {(agent: object, signal: AbortSignal) => Promise<object>} input.projectFor - resolve the calling session's project.
 * @returns {object} tool definition options.
 */
export function buildMemoryToolOptions({ projectFor }) {
  return {
    name: "memory",
    description:
      "Read and maintain this project's persistent memory, stored outside the repository under ~/.dsh/auto-memory. " +
      "Paths are virtual: /memories is the directory and /memories/MEMORY.md is the index loaded into future sessions. " +
      "Use view to list or read, create for a new .md file, str_replace to change exactly one occurrence, insert to add lines, delete to remove a file, and rename to move one. " +
      "Each memory file holds one fact, is named <name>.md, and starts with frontmatter: name, description, and metadata.type (user, feedback, project, or reference). " +
      "Save durable preferences, corrections, decisions, constraints, and pitfalls; never save secrets or transient task state.",
    parameters: {
      command: {
        type: "string",
        required: true,
        enum: COMMANDS,
        description: "Operation to perform."
      },
      path: {
        type: "string",
        description: `Virtual path such as ${VIRTUAL_ROOT}/${INDEX_FILE} or ${VIRTUAL_ROOT}/prefer-pnpm.md. Required for every command except a root view.`
      },
      file_text: {
        type: "string",
        description:
          "For create: the complete file content. A memory file starts with ---, name: <kebab-case>, description: <one line>, metadata:, type: <user|feedback|project|reference> (indented), ---, then the body. Creating MEMORY.md with empty text writes the standard index header."
      },
      old_str: {
        type: "string",
        description: "For str_replace: text that must occur exactly once in the file."
      },
      new_str: {
        type: "string",
        description: "For str_replace: replacement text; omit or pass an empty string to delete the matched text."
      },
      insert_line: {
        type: "number",
        description: "For insert: zero-based line index at which to insert; 0 inserts before the first line."
      },
      insert_text: {
        type: "string",
        description: "For insert: text to insert as one or more lines."
      },
      new_path: {
        type: "string",
        description: "For rename: the destination virtual path."
      },
      numbered: {
        type: "boolean",
        description: "For view of a file: prefix each line with its 1-based line number."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          output: { type: "string", required: true },
          path: { type: "string" },
          changed: { type: "boolean" },
          bytes: { type: "number" },
          lines: { type: "number" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                kind: { type: "string", required: true, enum: ["file", "directory"] },
                bytes: { type: "number", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.output }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: args.command === "view" ? "Read project memory" : `${args.command} project memory`,
      kind: args.command === "view" ? "read" : "other",
      rawInput: args.path ?? VIRTUAL_ROOT
    }),
    execute: async (args, exec) => {
      const agent = exec?.agent;
      if (agent === undefined) {
        throw new MemoryError("memory requires a calling agent", "MEMORY_NO_AGENT");
      }
      const project = await projectFor(agent, exec?.signal);
      const store = project.store;
      const command = args.command;
      if (command === "view") {
        return viewToolOutput(store, MemoryStore.parseVirtualPath(args.path ?? VIRTUAL_ROOT), args.numbered === true);
      }
      const relativePath = MemoryStore.parseVirtualPath(requireString(args.path, "path"));
      if (command === "create") {
        const fileText = args.file_text === undefined ? "" : requireString(args.file_text, "file_text");
        const result = await store.create(relativePath, fileText);
        const output = [
          `Created ${result.path} (${formatBytes(result.bytes)}, ${result.lines} lines).`,
          result.indexWarning ??
            (relativePath === INDEX_FILE
              ? "This is the index injected into future sessions."
              : indexNote({ ...result, action: "created" })),
          ...(result.frontmatterProblems.length > 0
            ? [`Frontmatter: ${result.frontmatterProblems.join("; ")}. Fix it with str_replace.`]
            : [])
        ].join("\n");
        return { ok: true, output, path: result.path, changed: true, bytes: result.bytes, lines: result.lines };
      }
      if (command === "str_replace") {
        const oldStr = requireString(args.old_str, "old_str");
        const newStr = args.new_str === undefined ? "" : requireString(args.new_str, "new_str");
        const result = await store.strReplace(relativePath, oldStr, newStr);
        return {
          ok: true,
          output: [
            `Edited ${result.path} (${formatBytes(result.bytes)}, ${result.lines} lines).`,
            ...editIndexNote(result)
          ].join("\n"),
          path: result.path,
          changed: true,
          bytes: result.bytes,
          lines: result.lines
        };
      }
      if (command === "insert") {
        if (!Number.isSafeInteger(args.insert_line)) {
          throw new MemoryError("insert_line must be a non-negative integer", "MEMORY_INVALID_ARGUMENT");
        }
        const insertText = requireString(args.insert_text, "insert_text");
        const result = await store.insert(relativePath, args.insert_line, insertText);
        return {
          ok: true,
          output: [
            `Inserted text at line ${result.insertedAt} in ${result.path} (${formatBytes(result.bytes)}, ${result.lines} lines).`,
            ...editIndexNote(result)
          ].join("\n"),
          path: result.path,
          changed: true,
          bytes: result.bytes,
          lines: result.lines
        };
      }
      if (command === "delete") {
        const result = await store.delete(relativePath);
        const output = [
          `Deleted ${result.path}.`,
          result.indexWarning ?? (result.indexed ? "Removed its MEMORY.md index line." : "No MEMORY.md index line referenced it.")
        ].join("\n");
        return { ok: true, output, path: result.path, changed: true };
      }
      if (command === "rename") {
        const newPath = requireString(args.new_path, "new_path");
        const result = await store.rename(relativePath, MemoryStore.parseVirtualPath(newPath));
        const output = [
          `Renamed ${result.previousPath} to ${result.path}.`,
          result.indexWarning ?? (result.indexed ? "Updated its MEMORY.md link." : "No MEMORY.md link referenced it.")
        ].join("\n");
        return { ok: true, output, path: result.path, changed: true };
      }
      throw new MemoryError(`unknown command ${JSON.stringify(command)}`, "MEMORY_INVALID_ARGUMENT");
    }
  };
}
