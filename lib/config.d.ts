import z from "@deepseek-ai/schemastery";
/**
 * Plugin configuration.
 *
 * `root` is resolved against `$DSH_HOME` unless it is absolute or starts with
 * `~`. All size limits are bytes; line limits are used only when rendering the
 * injected index, never when writing files.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    root: z<string, string, "defined">;
    maxIndexBytes: z<number, number, "defined">;
    maxIndexLines: z<number, number, "defined">;
    maxFileBytes: z<number, number, "defined">;
    maxFiles: z<number, number, "defined">;
    projectRootMarkers: z<string[], string[], "defined">;
    inject: z<boolean, boolean, "defined">;
    injectInSubagents: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    rules: z<boolean, boolean, "defined">;
    userRuleDirs: z<string[], string[], "defined">;
    projectRuleDirs: z<string[], string[], "defined">;
    maxRuleBytes: z<number, number, "defined">;
    maxRulesBytes: z<number, number, "defined">;
    maxRules: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    root: z<string, string, "defined">;
    maxIndexBytes: z<number, number, "defined">;
    maxIndexLines: z<number, number, "defined">;
    maxFileBytes: z<number, number, "defined">;
    maxFiles: z<number, number, "defined">;
    projectRootMarkers: z<string[], string[], "defined">;
    inject: z<boolean, boolean, "defined">;
    injectInSubagents: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    rules: z<boolean, boolean, "defined">;
    userRuleDirs: z<string[], string[], "defined">;
    projectRuleDirs: z<string[], string[], "defined">;
    maxRuleBytes: z<number, number, "defined">;
    maxRulesBytes: z<number, number, "defined">;
    maxRules: z<number, number, "defined">;
}>>, "plain">;
/** Every plugin option after schema defaults are applied. */
export type ConfigShape = Schemastery.TypeT<typeof Config>;
/** Validated configuration with the resolved absolute memory root. */
export interface ResolvedConfig extends ConfigShape {
    memoryRoot: string;
}
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
