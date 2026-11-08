/**
 * Small glob matcher for rule `paths` patterns.
 *
 * Supports `*`, `**`, `?`, brace expansion (`{a,b}`), and character classes
 * (`[abc]`). Patterns are relative to the rule's base directory and use `/`
 * separators on every platform.
 */
/**
 * Expand brace alternatives with a hard budget. A pattern over budget is
 * returned unexpanded, so its literal braces match nothing rather than
 * consuming unbounded memory.
 */
export declare function expandBraces(pattern: string): string[];
/**
 * Compile one glob pattern into an anchored regular expression.
 */
export declare function compileGlob(pattern: string): RegExp;
/**
 * Test one `/`-separated relative path against a glob.
 */
export declare function matchGlob(path: string, pattern: string): boolean;
