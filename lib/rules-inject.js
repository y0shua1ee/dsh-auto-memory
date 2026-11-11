import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isAbsolute, relative, resolve } from "node:path";
import { enterWithMessage, isSubagent } from "./inject.js";
import { RULE_MESSAGE_KIND, RuleIndex, renderRules } from "./rules.js";
const FILE_TOOLS = new Set(["read", "write", "edit"]);
function toPosix(value) {
    return value.replaceAll("\\", "/");
}
function ruleMatches(rule, touched, cwd, ruleRoot) {
    if (rule.matchers.length === 0)
        return true;
    const base = rule.scope === "user" ? cwd : ruleRoot;
    for (const raw of touched) {
        const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
        const rel = relative(base, absolute);
        if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel))
            continue;
        const posix = toPosix(rel);
        if (rule.matchers.some((matcher) => matcher.test(posix)))
            return true;
    }
    return false;
}
function visibleRuleDigests(agent, decision) {
    const visible = new Map();
    const collect = (message) => {
        if (!isRulesMessage(message))
            return;
        const entries = Array.isArray(message.source.rules)
            ? message.source.rules
            : [];
        for (const entry of entries) {
            if (typeof entry !== "object" || entry === null)
                continue;
            const candidate = entry;
            if (typeof candidate.key === "string" && typeof candidate.digest === "string") {
                visible.set(candidate.key, candidate.digest);
            }
        }
    };
    for (const message of decision.messages)
        collect(message);
    for (const seq of agent.session.surface.nodes) {
        const event = agent.session.eventAt(seq);
        if (event?.type === "user/message")
            collect(event.data);
    }
    for (const message of agent.inbox.nextStep)
        collect(message);
    return visible;
}
function isRulesMessage(message) {
    return message?.source.kind === RULE_MESSAGE_KIND;
}
/** Read the `file_path` of a read/write/edit call from validated tool arguments. */
function filePathOf(argumentsValue) {
    if (typeof argumentsValue !== "object" || argumentsValue === null)
        return undefined;
    const value = argumentsValue.file_path;
    return typeof value === "string" ? value.trim() : undefined;
}
/**
 * Register rule injection and file-touch tracking.
 */
export function createRulesFeature({ projectFor, config, logger }) {
    const index = new RuleIndex({
        userRuleDirs: config.userRuleDirs,
        projectRuleDirs: config.projectRuleDirs,
        maxRuleBytes: config.maxRuleBytes,
        maxRules: config.maxRules,
        maxRulesBytes: config.maxRulesBytes
    });
    const touched = new WeakMap();
    const toolResult = (exec, result) => {
        if (result.isError)
            return;
        if (!FILE_TOOLS.has(exec.name))
            return;
        const agent = exec.agent;
        if (agent === undefined)
            return;
        if (!config.injectInSubagents && isSubagent(agent))
            return;
        const raw = filePathOf(exec.arguments);
        if (raw === undefined || raw.length === 0)
            return;
        let paths = touched.get(agent.session);
        if (paths === undefined) {
            paths = new Set();
            touched.set(agent.session, paths);
        }
        paths.add(raw);
    };
    const preStep = async ({ agent, messages, signal }, next) => {
        const decision = await next();
        if (decision.kind === "reject")
            return decision;
        if (!config.rules)
            return decision;
        if (!config.injectInSubagents && isSubagent(agent))
            return decision;
        try {
            const project = await projectFor(agent, signal);
            const { rules, warnings } = await index.collect({
                cwd: project.cwd,
                projectRoot: project.ruleRoot
            });
            if (rules.length === 0)
                return decision;
            const sessionTouches = touched.get(agent.session) ?? new Set();
            const eligible = rules.filter((rule) => ruleMatches(rule, sessionTouches, project.cwd, project.ruleRoot));
            if (eligible.length === 0)
                return decision;
            const visible = visibleRuleDigests(agent, decision);
            const fresh = eligible.filter((rule) => visible.get(rule.key) !== rule.digest);
            if (fresh.length === 0)
                return decision;
            const rendered = renderRules(fresh, config.maxRulesBytes, warnings);
            if (rendered === undefined)
                return decision;
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
        }
        catch (error) {
            if (signal?.aborted)
                return decision;
            logger?.warn?.("auto-memory: could not load rules for this step: %o", error);
            return decision;
        }
    };
    return { preStep, toolResult };
}
