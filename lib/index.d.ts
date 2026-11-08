import { Config, resolveConfig } from "./config.js";
import type { ConfigShape } from "./config.js";
import type { PluginContext } from "./types.js";
export { Config, resolveConfig };
/** Plugin name shown by the Loader. */
export declare const name = "auto-memory";
/** Services required before the plugin activates. */
export declare const inject: readonly ["tools", "systemPrompt", "workingDirectory"];
/**
 * Mount the memory tool, its prompt guidance, and the per-step index
 * injection.
 */
export declare function apply(ctx: PluginContext, config?: Partial<ConfigShape>): void;
