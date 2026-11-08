import type { ResolvedConfig } from "./config.js";
import type { MemoryStore } from "./store.js";
import type { Agent, EnterDecision, Logger, Message, PreStepDecision, PreStepHandler } from "./types.js";
/** Message source kind used to recognize injected memory snapshots. */
export declare const AUTO_MEMORY_SOURCE_KIND = "auto-memory";
/** The project fields the injection path needs. */
export interface InjectionProject {
    key: string;
    dirLabel: string;
    store: MemoryStore;
    cwd: string;
    projectRoot: string;
    ruleRoot: string;
}
export type ProjectFor = (agent: Agent, signal?: AbortSignal) => Promise<InjectionProject>;
/**
 * Whether the index holds anything beyond its heading and HTML comments.
 * A header-only index (for example after deleting the last memory) carries no
 * context and is not worth injecting.
 */
export declare function hasIndexEntries(content: string): boolean;
export declare function isSubagent(agent: Agent): boolean;
export declare function enterWithMessage(agent: Agent, messages: Message[], decision: EnterDecision, message: Message, isManaged: (candidate: Message) => boolean): PreStepDecision;
/**
 * Create the `agent/pre-step` listener that injects the project index.
 *
 * The index is re-read on every step. The rendered snapshot's digest is
 * recorded in the message source, so the same snapshot is never injected
 * twice; after compaction the old message leaves the surface and the next step
 * injects the current index again.
 */
export declare function createPreStepHandler({ projectFor, config, logger }: {
    projectFor: ProjectFor;
    config: ResolvedConfig;
    logger?: Logger;
}): PreStepHandler;
