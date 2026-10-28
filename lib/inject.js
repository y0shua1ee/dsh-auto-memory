import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { renderMemoryContext } from "./render.js";

/** Message source kind used to recognize injected memory snapshots. */
export const AUTO_MEMORY_SOURCE_KIND = "auto-memory";

function isAutoMemoryMessage(message) {
  return message?.source?.kind === AUTO_MEMORY_SOURCE_KIND;
}

/**
 * Whether the index holds anything beyond its heading and HTML comments.
 * A header-only index (for example after deleting the last memory) carries no
 * context and is not worth injecting.
 *
 * @param {string} content - raw MEMORY.md text.
 * @returns {boolean} true when at least one non-heading line exists.
 */
export function hasIndexEntries(content) {
  return content
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

export function isSubagent(agent) {
  const header = agent?.session?.header;
  if (header === undefined || header === null) return false;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

function hasDigest(agent, decision, digest) {
  const matches = (message) => isAutoMemoryMessage(message) && message.source.digest === digest;
  if (decision.messages.some(matches)) return true;
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    if (event?.type === "user/message" && matches(event.data)) return true;
  }
  return agent.inbox.nextStep.some(matches);
}

export function enterWithMessage(agent, messages, decision, message, isManaged) {
  const pending = agent.inbox.nextStep.filter(isManaged);
  if (decision.messages.length === 0) {
    if (pending.length > 0) {
      agent.inbox.replace(pending[0].id, message);
      for (const extra of pending.slice(1)) agent.inbox.remove(extra.id);
    } else {
      agent.inbox.prepend("next-step", message);
    }
    return decision;
  }
  for (const extra of pending) agent.inbox.remove(extra.id);
  const lastClaimedIndex = decision.messages.findLastIndex((candidate) => messages.includes(candidate));
  return {
    ...decision,
    messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message)
  };
}

/**
 * Create the `agent/pre-step` listener that injects the project index.
 *
 * The index is re-read on every step. The rendered snapshot's digest is
 * recorded in the message source, so the same snapshot is never injected
 * twice; after compaction the old message leaves the surface and the next step
 * injects the current index again.
 *
 * @param {object} input - listener dependencies.
 * @param {(agent: object, signal: AbortSignal) => Promise<object>} input.projectFor - resolve the session's project.
 * @param {object} input.config - normalized plugin configuration.
 * @param {object} [input.logger] - host logger.
 * @returns {(payload: object, next: Function) => Promise<object>} pre-step listener.
 */
export function createPreStepHandler({ projectFor, config, logger }) {
  return async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    if (!config.inject) return decision;
    if (!config.injectInSubagents && isSubagent(agent)) return decision;
    try {
      const project = await projectFor(agent, signal);
      const index = await project.store.index();
      if (!index.exists || !hasIndexEntries(index.content)) return decision;
      const rendered = renderMemoryContext({
        content: index.content,
        memoryDir: project.dirLabel,
        projectKey: project.key,
        maxBytes: config.maxIndexBytes,
        maxLines: config.maxIndexLines,
        replacePrevious: true
      });
      if (hasDigest(agent, decision, rendered.digest)) return decision;
      const message = createUserMessage({
        content: [{ type: "text", text: rendered.text }],
        source: {
          kind: AUTO_MEMORY_SOURCE_KIND,
          form: "memory",
          projectKey: project.key,
          digest: rendered.digest,
          baseline: true
        }
      });
      return enterWithMessage(agent, messages, decision, message, isAutoMemoryMessage);
    } catch (error) {
      if (signal?.aborted) return decision;
      logger?.warn?.("auto-memory: could not load project memory for this step: %o", error);
      return decision;
    }
  };
}
