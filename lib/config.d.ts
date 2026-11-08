/** Every plugin option after defaults are applied. */
export interface ConfigShape {
    root: string;
    maxIndexBytes: number;
    maxIndexLines: number;
    maxFileBytes: number;
    maxFiles: number;
    projectRootMarkers: string[];
    inject: boolean;
    injectInSubagents: boolean;
    guidance: boolean;
    rules: boolean;
    userRuleDirs: string[];
    projectRuleDirs: string[];
    maxRuleBytes: number;
    maxRulesBytes: number;
    maxRules: number;
}
/** Validated configuration with the resolved absolute memory root. */
export interface ResolvedConfig extends ConfigShape {
    memoryRoot: string;
}
/**
 * Plugin configuration.
 *
 * `root` is resolved against `$DSH_HOME` unless it is absolute or starts with
 * `~`. All size limits are bytes; line limits are used only when rendering the
 * injected index, never when writing files.
 */
export declare const Config: unknown;
/** Values used when `apply` is called directly with an incomplete config. */
export declare const DEFAULT_CONFIG: ConfigShape;
/**
 * Resolve the configured memory root.
 *
 * @param configured - absolute path, `~`-prefixed path, or a path relative to
 *   the DeepSeek Harness home.
 * @returns normalized absolute directory.
 */
export declare function resolveMemoryRoot(configured: string): string;
/**
 * Normalize configuration for direct `apply` calls. Loader-normalized config
 * already carries schema defaults; this function still validates every value so
 * a bad programmatic mount fails loudly instead of creating a half-working
 * memory store.
 */
export declare function resolveConfig(config?: Partial<ConfigShape>): ResolvedConfig;
