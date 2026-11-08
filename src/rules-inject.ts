import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isAbsolute, relative, resolve } from "node:path";
import { enterWithMessage, isSubagent } from "./inject.js";
import type { ProjectFor } from "./inject.js";
import type { ResolvedConfig } from "./config.js";
import { RULE_MESSAGE_KIND, RuleIndex, renderRules } from "./rules.js";
import type { Rule } from "./rules.js";
import type {
  Agent,
  EnterDecision,
  Logger,
  Message,
  PreStepDecision,
  PreStepHandler,
  PreStepPayload,
  RuleRef,
  ToolExecEvent,
  ToolResultEvent
} from "./types.js";

const FILE_TOOLS = new Set(["read", "write", "edit"]);

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function ruleMatches(rule: Rule, touched: Set<string>, cwd: string, ruleRoot: string): boolean {
  if (rule.matchers.length === 0) return true;
  const base = rule.scope === "user" ? cwd : ruleRoot;
  for (const raw of touched) {
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    const rel = relative(base, absolute);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) continue;
    const posix = toPosix(rel);
    if (rule.matchers.some((matcher) => matcher.test(posix))) return true;
  }
  return false;
}

function visibleRuleDigests(agent: Agent, decision: EnterDecision): Map<string, string> {
  const visible = new Map<string, string>();
  const collect = (message: Message | undefined): void => {
    if (message?.source?.kind !== RULE_MESSAGE_KIND) return;
    const entries = message.source.rules;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as RuleRef;
      if (typeof candidate.key === "string" && typeof candidate.digest === "string") {
        visible.set(candidate.key, candidate.digest);
      }
    }
  };
  for (const message of decision.messages) collect(message);
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    if (event?.type === "user/message") collect(event.data);
  }
  for (const message of agent.inbox.nextStep) collect(message);
  return visible;
}

function isRulesMessage(message: Message | undefined): boolean {
  return message?.source?.kind === RULE_MESSAGE_KIND;
}

/**
 * Register rule injection and file-touch tracking.
 */
export function createRulesFeature({
  projectFor,
  config,
  logger
}: {
  projectFor: ProjectFor;
  config: ResolvedConfig;
  logger?: Logger;
}): {
  preStep: PreStepHandler;
  toolResult: (exec: ToolExecEvent, result: ToolResultEvent) => void;
} {
  const index = new RuleIndex({
    userRuleDirs: config.userRuleDirs,
    projectRuleDirs: config.projectRuleDirs,
    maxRuleBytes: config.maxRuleBytes,
    maxRules: config.maxRules,
    maxRulesBytes: config.maxRulesBytes
  });
  const touched = new WeakMap<object, Set<string>>();

  const toolResult = (exec: ToolExecEvent, result: ToolResultEvent): void => {
    if (result?.isError) return;
    if (!FILE_TOOLS.has(exec?.name ?? "")) return;
    const agent = exec.agent;
    if (agent === undefined) return;
    if (!config.injectInSubagents && isSubagent(agent)) return;
    const raw = exec.arguments?.file_path;
    if (typeof raw !== "string" || raw.trim().length === 0) return;
    let paths = touched.get(agent.session);
    if (paths === undefined) {
      paths = new Set();
      touched.set(agent.session, paths);
    }
    paths.add(raw.trim());
  };

  const preStep = async ({ agent, messages, signal }: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    if (!config.rules) return decision;
    if (!config.injectInSubagents && isSubagent(agent)) return decision;
    try {
      const project = await projectFor(agent, signal);
      const { rules, warnings } = await index.collect({
        cwd: project.cwd,
        projectRoot: project.ruleRoot
      });
      if (rules.length === 0) return decision;
      const sessionTouches = touched.get(agent.session) ?? new Set<string>();
      const eligible = rules.filter((rule) =>
        ruleMatches(rule, sessionTouches, project.cwd, project.ruleRoot)
      );
      if (eligible.length === 0) return decision;
      const visible = visibleRuleDigests(agent, decision);
      const fresh = eligible.filter((rule) => visible.get(rule.key) !== rule.digest);
      if (fresh.length === 0) return decision;
      const rendered = renderRules(fresh, config.maxRulesBytes, warnings);
      if (rendered === undefined) return decision;
      const message = createUserMessage({
        content: [{ type: "text", text: rendered.text }],
        source: {
          kind: RULE_MESSAGE_KIND,
          form: "instructions",
          digest: rendered.digest,
          rules: rendered.rules.map((rule) => ({
            key: rule.key,
            path: rule.path,
            scope: rule.scope,
            digest: rule.digest
          }))
        }
      });
      return enterWithMessage(agent, messages, decision, message, isRulesMessage);
    } catch (error) {
      if (signal?.aborted) return decision;
      logger?.warn?.("auto-memory: could not load rules for this step: %o", error);
      return decision;
    }
  };

  return { preStep, toolResult };
}
