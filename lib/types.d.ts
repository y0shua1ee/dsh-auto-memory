import type { Message, UserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
export type { Message, UserMessage };
/** The calling agent, derived from the tool execution surface DSH hands a tool. */
export type Agent = NonNullable<ToolRunContext["agent"]>;
/** The live session the plugin reads pending input and injected history from. */
export type Session = Agent["session"];
/** The agent-owned inbox queue used to hold a message for the next step. */
export type Inbox = Agent["inbox"];
/** Rule identity carried by an injected rules message. */
export interface RuleRef {
    key: string;
    path: string;
    scope: RuleScope;
    digest: string;
}
/**
 * Source metadata for an injected `MEMORY.md` snapshot.
 *
 * `MessageSourceMap` is merge-extensible by design; declaring the plugin's own
 * kinds gives the injected messages a real type without pretending they are
 * one of the built-in producer kinds.
 */
export interface AutoMemorySource {
    readonly kind: "auto-memory";
    readonly projectKey: string;
    readonly digest: string;
    readonly baseline: boolean;
}
/** Source metadata for one injected batch of workspace rules. */
export interface AutoRulesSource {
    readonly kind: "auto-rules";
    readonly form: "instructions";
    readonly digest: string;
    readonly rules: readonly RuleRef[];
}
declare module "@deepseek-ai/dsh-llm/message" {
    interface MessageSourceMap {
        "auto-memory": AutoMemorySource;
        "auto-rules": AutoRulesSource;
    }
}
/** An injected memory snapshot, narrowed by its source kind. */
export type AutoMemoryMessage = Message & {
    readonly source: AutoMemorySource;
};
/** An injected rules batch, narrowed by its source kind. */
export type AutoRulesMessage = Message & {
    readonly source: AutoRulesSource;
};
/** Whether the loop enters the proposed step with the replacement messages. */
export interface EnterDecision {
    kind: "enter";
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
}
/** Whether the loop rejects the proposed step. */
export interface RejectDecision {
    kind: "reject";
}
export type PreStepDecision = EnterDecision | RejectDecision;
export type PreStepNext = () => Promise<PreStepDecision>;
export interface PreStepPayload {
    agent: Agent;
    messages: UserMessage[];
    step: number;
    signal: AbortSignal;
}
export type PreStepHandler = (payload: PreStepPayload, next: PreStepNext) => Promise<PreStepDecision>;
/** The frozen execution record observed by a `tools/result` listener. */
export type ToolExecEvent = Readonly<ToolExecution>;
/** The frozen outcome observed by a `tools/result` listener. */
export type ToolResultEvent = Readonly<ToolExecutionResult>;
export type RuleScope = "user" | "project";
export interface SystemPromptSection {
    name: string;
    order: number;
    text: string;
}
export interface Logger {
    warn(message: string, ...args: unknown[]): void;
}
/** The Cordis services this plugin consumes. */
export interface PluginContext {
    tools: {
        register(tool: ToolDefinition): void;
    };
    systemPrompt: {
        section(section: SystemPromptSection): void;
        getSectionOrder(key: string): number;
    };
    workingDirectory: {
        ensure(agent: Agent, signal?: AbortSignal): Promise<string>;
    };
    on(event: "agent/pre-step", handler: PreStepHandler): void;
    on(event: "tools/result", handler: (exec: ToolExecEvent, result: ToolResultEvent) => void): void;
    logger?: Logger;
}
