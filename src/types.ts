/** One text block in a user-role message. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Rule identity carried by an injected rules message. */
export interface RuleRef {
  key: string;
  path: string;
  scope: RuleScope;
  digest: string;
}

/** Message metadata used to recognize and deduplicate injected snapshots. */
export interface MessageSource {
  kind: string;
  form?: string;
  projectKey?: string;
  digest?: string;
  baseline?: boolean;
  rules?: RuleRef[];
  [field: string]: unknown;
}

/** The message shape the memory and rules features inject. */
export interface Message {
  id: string;
  role?: string;
  content: TextContent[];
  source?: MessageSource;
}

/** Session surface nodes, newest last. */
export interface Surface {
  nodes: number[];
}

/** One recorded session event. */
export interface SessionEvent {
  type?: string;
  data?: Message;
}

/** Session header fields the plugin reads. */
export interface SessionHeader {
  cwd?: string;
  origin?: string;
  delegationDepth?: number;
  [field: string]: unknown;
}

/** The session slice the plugin uses. */
export interface Session {
  header?: SessionHeader;
  surface: Surface;
  eventAt(seq: number): SessionEvent | undefined;
}

/** The inbox queue used to hold a message for the next step. */
export interface Inbox {
  nextStep: Message[];
  prepend(queue: string, message: Message): void;
  replace(id: string, message: Message): void;
  remove(id: string): void;
}

/** The calling agent. */
export interface Agent {
  session: Session;
  inbox: Inbox;
}

export interface EnterDecision {
  kind: "enter";
  messages: Message[];
}

export interface RejectDecision {
  kind: "reject";
}

export type PreStepDecision = EnterDecision | RejectDecision;

export type PreStepNext = () => Promise<PreStepDecision>;

export interface PreStepPayload {
  agent: Agent;
  messages: Message[];
  step: number;
  signal: AbortSignal;
}

export type PreStepHandler = (
  payload: PreStepPayload,
  next: PreStepNext
) => Promise<PreStepDecision>;

/** The execution context passed to a tool body. */
export interface ToolExec {
  agent?: Agent;
  signal?: AbortSignal;
}

/** The normalized result observed by a `tools/result` listener. */
export interface ToolResultEvent {
  isError?: boolean;
}

/** The execution record observed by a `tools/result` listener. */
export interface ToolExecEvent {
  name?: string;
  arguments?: { file_path?: unknown };
  agent?: Agent;
  signal?: AbortSignal;
}

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
    register(tool: unknown): void;
  };
  systemPrompt: {
    section(section: SystemPromptSection): void;
    getSectionOrder(key: string): number;
  };
  workingDirectory: {
    ensure(agent: Agent, signal?: AbortSignal): Promise<string>;
  };
  on(event: "agent/pre-step", handler: PreStepHandler): void;
  on(
    event: "tools/result",
    handler: (exec: ToolExecEvent, result: ToolResultEvent) => void
  ): void;
  logger?: Logger;
}
