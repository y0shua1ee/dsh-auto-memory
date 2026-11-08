/** Name of the index file loaded into every session. */
export declare const INDEX_FILE = "MEMORY.md";
/** Virtual root exposed to the model. */
export declare const VIRTUAL_ROOT = "/memories";
/** Header written when the index is created automatically. */
export declare const INDEX_HEADER = "# Project memory\n\n<!-- One line per memory: - [name](name.md) \u2014 description. Keep this index short; details live in the memory files. -->\n";
/** A memory operation failed with a model-actionable reason. */
export declare class MemoryError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export interface MemoryStoreOptions {
    root: string;
    maxFileBytes: number;
    maxIndexBytes: number;
    maxIndexLines?: number;
    maxFiles: number;
}
export interface IndexMissing {
    exists: false;
}
export interface IndexPresent {
    exists: true;
    content: string;
    bytes: number;
    mtimeMs: number;
    /** True when the file is larger than the safety cap and only its start was read. */
    truncated: boolean;
}
export type IndexSnapshot = IndexMissing | IndexPresent;
/** Whether the index is close to, or past, its injection budget. */
export interface IndexBudget {
    lines: number;
    bytes: number;
    lineLimit: number;
    byteLimit: number;
    overLimit: boolean;
    nearLimit: boolean;
    reasons: Array<"lines" | "bytes" | "source">;
}
export interface ListEntry {
    path: string;
    kind: "file" | "directory";
    bytes: number;
}
export interface DirectoryView {
    kind: "directory";
    entries: ListEntry[];
}
export interface FileView {
    kind: "file";
    content: string;
    bytes: number;
    lines: number;
}
export type ViewResult = DirectoryView | FileView;
export interface WriteInfo {
    bytes: number;
    lines: number;
}
export interface IndexStatus {
    indexed?: boolean;
    indexWarning?: string;
}
export interface CreateResult extends WriteInfo {
    path: string;
    indexed: boolean;
    indexWarning?: string;
    indexBudget?: IndexBudget;
    indexBudgetWarning?: string;
    frontmatterProblems: string[];
}
export interface EditResult extends WriteInfo, IndexStatus {
    path: string;
    indexBudget?: IndexBudget;
    indexBudgetWarning?: string;
    frontmatterProblems: string[];
}
export interface InsertResult extends EditResult {
    insertedAt: number;
}
export interface DeleteResult {
    path: string;
    changed: true;
    indexed: boolean;
    indexWarning?: string;
    indexBudget?: IndexBudget;
    indexBudgetWarning?: string;
}
export interface RenameResult {
    path: string;
    previousPath: string;
    changed: true;
    indexed: boolean;
    indexWarning?: string;
    indexBudget?: IndexBudget;
    indexBudgetWarning?: string;
    frontmatterProblems: string[];
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
export declare class MemoryStore {
    #private;
    readonly root: string;
    readonly maxFileBytes: number;
    readonly maxIndexBytes: number;
    readonly maxIndexLines: number;
    readonly maxFiles: number;
    constructor({ root, maxFileBytes, maxIndexBytes, maxIndexLines, maxFiles }: MemoryStoreOptions);
    /**
     * Parse a model-supplied virtual path.
     *
     * @param value - path such as `/memories/MEMORY.md`.
     * @returns project-relative path, or `''` for the root.
     */
    static parseVirtualPath(value: unknown): string;
    /**
     * Read the index, if it exists.
     */
    index(): Promise<IndexSnapshot>;
    /**
     * Compare the index against the 200-line and 25KB injection budget.
     *
     * The budget is a read limit, not a hard write limit: a write may leave the
     * index over budget, but the caller must tell the model to rewrite it because
     * everything past the limit is dropped on the next load.
     */
    indexBudget(content: string, truncated?: boolean): IndexBudget;
    /**
     * List the root or one subtree.
     */
    list(relativePath?: string): Promise<ListEntry[]>;
    /**
     * Read one file or list one directory.
     */
    view(relativePath?: string): Promise<ViewResult>;
    /**
     * Create a new file. Creating a topic file also appends an index entry when
     * the index exists and does not already link the file, and reports what its
     * frontmatter is missing without refusing the write.
     */
    create(relativePath: string, text?: string): Promise<CreateResult>;
    /**
     * Replace exactly one occurrence of `oldStr`. Editing a topic file also
     * refreshes its index line when that line still matches the old frontmatter.
     */
    strReplace(relativePath: string, oldStr: string, newStr?: string): Promise<EditResult>;
    /**
     * Insert text at a zero-based line index. Like `strReplace`, it refreshes a
     * topic file's index line that still matches the old frontmatter.
     */
    insert(relativePath: string, line: number, text: string): Promise<InsertResult>;
    /**
     * Delete one file. Deleting a topic file also removes index lines that link it.
     */
    delete(relativePath: string): Promise<DeleteResult>;
    /**
     * Rename one file. Links in the index follow the file, and a title still
     * generated from the old file name follows the new one.
     */
    rename(oldPath: string, newPath: string): Promise<RenameResult>;
}
