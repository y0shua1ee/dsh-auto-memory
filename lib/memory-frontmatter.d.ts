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
/** Memory types, mirroring Claude Code's memory taxonomy. */
export declare const MEMORY_TYPES: readonly ["user", "feedback", "project", "reference"];
export type MemoryType = (typeof MEMORY_TYPES)[number];
/** Memory names share DSH's skill-name shape so `[[name]]` maps to `name.md`. */
export declare const MEMORY_NAME: RegExp;
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
/**
 * Read a memory file's frontmatter fields and body.
 */
export declare function parseMemory(content: string): ParsedMemory;
/**
 * Describe each frontmatter problem as a stable code plus a readable message.
 *
 * Codes stay stable when only the offending value changes, so callers can tell
 * "the same problem still exists" from "this edit introduced a new problem".
 */
export declare function memoryFrontmatterIssues(parsed: ParsedMemory, fileStem?: string, filePath?: string): MemoryIssue[];
/**
 * List what a topic file's frontmatter is missing, for a non-blocking hint.
 */
export declare function memoryFrontmatterProblems(parsed: ParsedMemory, fileStem?: string, filePath?: string): string[];
/**
 * Record the write time in a `modified` frontmatter field.
 *
 * Claude Code records an ISO 8601 timestamp when it writes a memory file that
 * begins with YAML frontmatter. A file without frontmatter is left untouched;
 * an existing top-level or `metadata.modified` value is replaced in place, and
 * a `metadata.modified` value is added only when a `metadata:` block exists.
 * Line endings and every other line are preserved.
 */
export declare function touchModified(content: string, now?: Date): string;
