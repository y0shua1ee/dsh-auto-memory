import { MemoryStore } from "./store.js";
import type { ListEntry } from "./store.js";
import type { Agent, TextContent, ToolExec } from "./types.js";
declare const COMMANDS: readonly ["view", "create", "str_replace", "insert", "delete", "rename"];
type MemoryCommand = (typeof COMMANDS)[number];
/** A project resolved for the calling session. */
export interface MemoryProject {
    store: MemoryStore;
}
export type ProjectFor = (agent: Agent, signal?: AbortSignal) => Promise<MemoryProject>;
export interface MemoryToolArgs {
    command: MemoryCommand;
    path?: unknown;
    file_text?: unknown;
    old_str?: unknown;
    new_str?: unknown;
    insert_line?: unknown;
    insert_text?: unknown;
    new_path?: unknown;
    numbered?: unknown;
}
export interface MemoryToolResult {
    ok: true;
    output: string;
    path?: string;
    changed?: boolean;
    bytes?: number;
    lines?: number;
    entries?: ListEntry[];
}
interface ToolParameter {
    type: string;
    required?: boolean;
    enum?: readonly string[];
    description?: string;
}
export interface MemoryToolOptions {
    name: string;
    description: string;
    parameters: Record<string, ToolParameter>;
    output: {
        schema: Record<string, unknown>;
        render: (args: MemoryToolArgs, value: MemoryToolResult) => TextContent[];
    };
    presentCall: (args: MemoryToolArgs) => {
        card: string;
        title: string;
        kind: string;
        rawInput: string;
    };
    execute: (args: Record<string, unknown>, exec?: ToolExec) => Promise<MemoryToolResult>;
}
/**
 * Build the `memory` tool definition options.
 *
 * The returned object is passed to `defineTool` by the plugin entry. Keeping it
 * free of `defineTool` imports lets the command semantics be tested without a
 * running harness.
 */
export declare function buildMemoryToolOptions({ projectFor }: {
    projectFor: ProjectFor;
}): MemoryToolOptions;
export {};
