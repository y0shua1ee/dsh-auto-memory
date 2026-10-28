import { pathToFileURL } from "node:url";

const appNodeModules =
  process.env.DSH_APP_NODE_MODULES ?? "/tmp/dsh-app/dsh/node_modules";
const anchor = pathToFileURL(`${appNodeModules}/@deepseek-ai/dsh-llm/package.json`).href;

/**
 * Resolve DSH framework imports from the packaged application during tests.
 * The plugin itself only declares peers; at runtime the launcher installs the
 * same resolution through its immutable runtime table.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@deepseek-ai/")) {
    return nextResolve(specifier, { ...context, parentURL: anchor });
  }
  return nextResolve(specifier, context);
}
