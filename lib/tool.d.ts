import type { DefineToolOptions, InferArgs, InferValue } from "@deepseek-ai/dsh-tools";
import { MemoryStore } from "./store.js";
import type { Agent } from "./types.js";
/** A project resolved for the calling session. */
export interface MemoryProject {
    store: MemoryStore;
}
export type ProjectFor = (agent: Agent, signal?: AbortSignal) => Promise<MemoryProject>;
declare const MEMORY_PARAMETERS: {
    readonly command: {
        readonly type: "string";
        readonly required: true;
        readonly enum: readonly ["view", "create", "str_replace", "insert", "delete", "rename"];
        readonly description: "Operation to perform.";
    };
    readonly path: {
        readonly type: "string";
        readonly description: "Virtual path such as /memories/MEMORY.md or /memories/prefer-pnpm.md. Required for every command except a root view.";
    };
    readonly file_text: {
        readonly type: "string";
        readonly description: "For create: the complete file content. A memory file starts with ---, name: <kebab-case>, description: <one line>, metadata:, type: <user|feedback|project|reference> (indented), ---, then the body. Creating MEMORY.md with empty text writes the standard index header.";
    };
    readonly old_str: {
        readonly type: "string";
        readonly description: "For str_replace: text that must occur exactly once in the file.";
    };
    readonly new_str: {
        readonly type: "string";
        readonly description: "For str_replace: replacement text; omit or pass an empty string to delete the matched text.";
    };
    readonly insert_line: {
        readonly type: "number";
        readonly description: "For insert: zero-based line index at which to insert; 0 inserts before the first line.";
    };
    readonly insert_text: {
        readonly type: "string";
        readonly description: "For insert: text to insert as one or more lines.";
    };
    readonly new_path: {
        readonly type: "string";
        readonly description: "For rename: the destination virtual path.";
    };
    readonly numbered: {
        readonly type: "boolean";
        readonly description: "For view of a file: prefix each line with its 1-based line number.";
    };
};
declare const MEMORY_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
            readonly required: true;
        };
        readonly output: {
            readonly type: "string";
            readonly required: true;
        };
        readonly path: {
            readonly type: "string";
        };
        readonly changed: {
            readonly type: "boolean";
        };
        readonly bytes: {
            readonly type: "number";
        };
        readonly lines: {
            readonly type: "number";
        };
        readonly entries: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly path: {
                        readonly type: "string";
                        readonly required: true;
                    };
                    readonly kind: {
                        readonly type: "string";
                        readonly required: true;
                        readonly enum: readonly ["file", "directory"];
                    };
                    readonly bytes: {
                        readonly type: "number";
                        readonly required: true;
                    };
                };
            };
        };
    };
};
export type MemoryToolArgs = InferArgs<typeof MEMORY_PARAMETERS>;
export type MemoryToolResult = InferValue<typeof MEMORY_OUTPUT_SCHEMA>;
export type MemoryToolOptions = DefineToolOptions<typeof MEMORY_PARAMETERS, typeof MEMORY_OUTPUT_SCHEMA>;
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
