import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Config, resolveConfig } from "./config.js";
import type { ConfigShape, ResolvedConfig } from "./config.js";
import { buildGuidance } from "./guidance.js";
import { createPreStepHandler } from "./inject.js";
import { createRulesFeature } from "./rules-inject.js";
import { displayPath, findProjectLocation, memoryDirectory, projectKey } from "./paths.js";
import { MemoryError, MemoryStore } from "./store.js";
import { buildMemoryToolOptions } from "./tool.js";
import type { Agent, PluginContext } from "./types.js";

export { Config, resolveConfig };

/** Plugin name shown by the Loader. */
export const name = "auto-memory";

/** Services required before the plugin activates. */
export const inject = ["tools", "systemPrompt", "workingDirectory"] as const;

const SECTION_ORDER_KEY = "TOOL_GOAL";

interface CachedProject {
  projectRoot: string;
  key: string;
  dir: string;
  dirLabel: string;
  store: MemoryStore;
}

interface Project extends CachedProject {
  cwd: string;
  ruleRoot: string;
}

/**
 * Cache one store per project root, not per working directory: sessions opened
 * in different subdirectories of one checkout must share the same memory
 * directory and the same mutation queue.
 */
function createProjectResolver(
  ctx: PluginContext,
  config: ResolvedConfig
): { resolve: (agent: Agent, signal?: AbortSignal) => Promise<Project> } {
  const projects = new Map<string, CachedProject>();
  return {
    async resolve(agent: Agent, signal?: AbortSignal): Promise<Project> {
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      const location = await findProjectLocation(cwd, config.projectRootMarkers, signal);
      const projectRoot = location.projectRoot;
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
            maxIndexLines: config.maxIndexLines,
            maxFiles: config.maxFiles
          })
        };
        projects.set(projectRoot, project);
      }
      return { ...project, cwd, ruleRoot: location.ruleRoot };
    }
  };
}

/**
 * Mount the memory tool, its prompt guidance, and the per-step index
 * injection.
 */
export function apply(ctx: PluginContext, config?: Partial<ConfigShape>): void {
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
      execute: async (args: Record<string, unknown>, exec?: Parameters<typeof options.execute>[1]) => {
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
