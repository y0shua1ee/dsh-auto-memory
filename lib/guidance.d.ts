import type { ResolvedConfig } from "./config.js";
/**
 * Build the stable system-prompt section that teaches the memory workflow.
 *
 * The exact project directory cannot be known here (one plugin instance serves
 * every session), so this text names the root and the tool contract; the
 * per-session injection carries the exact directory and index.
 */
export declare function buildGuidance(config: ResolvedConfig): string;
