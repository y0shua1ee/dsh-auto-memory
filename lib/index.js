import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Config, resolveConfig } from "./config.js";
import { buildGuidance } from "./guidance.js";
import { createPreStepHandler } from "./inject.js";
import { createRulesFeature } from "./rules-inject.js";
import { displayPath, findProjectRoot, memoryDirectory, projectKey } from "./paths.js";
import { MemoryError, MemoryStore } from "./store.js";
import { buildMemoryToolOptions } from "./tool.js";

export { Config, resolveConfig };

/** Plugin name shown by the Loader. */
export const name = "auto-memory";

/** Services required before the plugin activates. */
export const inject = ["tools", "systemPrompt", "workingDirectory"];

const SECTION_ORDER_KEY = "TOOL_GOAL";

/**
 * Cache one store per project root, not per working directory: sessions opened
 * in different subdirectories of one checkout must share the same memory
 * directory and the same mutation queue.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - normalized plugin configuration.
 * @returns {{resolve: (agent: object, signal: AbortSignal) => Promise<object>}}
 */
function createProjectResolver(ctx, config) {
  const projects = new Map();
  return {
    async resolve(agent, signal) {
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, signal);
      let project = projects.get(projectRoot);
      if (project === undefined) {
        const key = projectKey(projectRoot);
        const dir = memoryDirectory(config.memoryRoot, key);
        project = {
          projectRoot,
          key,
          dir,
          dirLabel: displayPath(dir),
          store: new MemoryStore({
            root: dir,
            maxFileBytes: config.maxFileBytes,
            maxIndexBytes: config.maxIndexBytes,
            maxFiles: config.maxFiles
          })
        };
        projects.set(projectRoot, project);
      }
      return { ...project, cwd };
    }
  };
}

/**
 * Mount the memory tool, its prompt guidance, and the per-step index
 * injection.
 *
 * @param {object} ctx - Cordis context with `tools`, `systemPrompt`, and
 *   `workingDirectory` services.
 * @param {object} [config] - raw or Loader-normalized plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const projects = createProjectResolver(ctx, resolved);
  if (process.env.DSH_AUTO_MEMORY_DEBUG === "1") {
    process.stderr.write(
      `[auto-memory] mounted root=${resolved.memoryRoot} guidance=${String(resolved.guidance)} rules=${String(resolved.rules)}\n`
    );
  }

  if (resolved.guidance) {
    ctx.systemPrompt.section({
      name: "tool:memory",
      order: ctx.systemPrompt.getSectionOrder(SECTION_ORDER_KEY),
      text: buildGuidance(resolved)
    });
  }

  const options = buildMemoryToolOptions({ projectFor: projects.resolve });
  ctx.tools.register(
    defineTool({
      ...options,
      execute: async (args, exec) => {
        try {
          return await options.execute(args, exec);
        } catch (error) {
          if (error instanceof MemoryError) throw new HarnessError(error.message, error.code);
          throw error;
        }
      }
    })
  );

  ctx.on(
    "agent/pre-step",
    createPreStepHandler({
      projectFor: projects.resolve,
      config: resolved,
      logger: ctx.logger
    })
  );

  if (resolved.rules) {
    const rules = createRulesFeature({
      projectFor: projects.resolve,
      config: resolved,
      logger: ctx.logger
    });
    ctx.on("agent/pre-step", rules.preStep);
    ctx.on("tools/result", rules.toolResult);
  }
}
