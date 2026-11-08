import type { ProjectFor } from "./inject.js";
import type { ResolvedConfig } from "./config.js";
import type { Logger, PreStepHandler, ToolExecEvent, ToolResultEvent } from "./types.js";
/**
 * Register rule injection and file-touch tracking.
 */
export declare function createRulesFeature({ projectFor, config, logger }: {
    projectFor: ProjectFor;
    config: ResolvedConfig;
    logger?: Logger;
}): {
    preStep: PreStepHandler;
    toolResult: (exec: ToolExecEvent, result: ToolResultEvent) => void;
};
