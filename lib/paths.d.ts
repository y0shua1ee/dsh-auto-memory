/**
 * Encode one project directory the same way DSH names its session project
 * directories: separator and drive runs collapse to a single `-`, unsafe code
 * units use `~XXXX`, and the result is wrapped in `--…--`.
 *
 * Keeping this identical to `@deepseek-ai/dsh-session-persistence-jsonl` means
 * memory folders sit next to the session folders they belong to when the user
 * browses `~/.dsh`.
 */
export declare function projectKey(cwd: string): string;
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
export declare function findProjectLocation(cwd: string, markers: string[], signal?: AbortSignal): Promise<ProjectLocation>;
/**
 * Return only the memory project root (the main checkout for linked worktrees).
 */
export declare function findProjectRoot(cwd: string, markers: string[], signal?: AbortSignal): Promise<string>;
/**
 * Abbreviate a path below the OS home for model-facing prompts.
 */
export declare function displayPath(path: string): string;
/**
 * Compute the memory directory for one project.
 */
export declare function memoryDirectory(memoryRoot: string, key: string): string;
