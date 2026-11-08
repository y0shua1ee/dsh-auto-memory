import { isAbsolute, join, parse, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Every plugin option after defaults are applied. */
export interface ConfigShape {
  root: string;
  maxIndexBytes: number;
  maxIndexLines: number;
  maxFileBytes: number;
  maxFiles: number;
  projectRootMarkers: string[];
  inject: boolean;
  injectInSubagents: boolean;
  guidance: boolean;
  rules: boolean;
  userRuleDirs: string[];
  projectRuleDirs: string[];
  maxRuleBytes: number;
  maxRulesBytes: number;
  maxRules: number;
}

/** Validated configuration with the resolved absolute memory root. */
export interface ResolvedConfig extends ConfigShape {
  memoryRoot: string;
}

/**
 * Plugin configuration.
 *
 * `root` is resolved against `$DSH_HOME` unless it is absolute or starts with
 * `~`. All size limits are bytes; line limits are used only when rendering the
 * injected index, never when writing files.
 */
export const Config: unknown = z.object({
  root: z.string().default("auto-memory"),
  maxIndexBytes: z.number().step(1).min(1024).default(25600),
  maxIndexLines: z.number().step(1).min(1).default(200),
  maxFileBytes: z.number().step(1).min(1024).default(65536),
  maxFiles: z.number().step(1).min(1).default(200),
  projectRootMarkers: z.array(z.string()).default([".git"]),
  inject: z.boolean().default(true),
  injectInSubagents: z.boolean().default(false),
  guidance: z.boolean().default(true),
  rules: z.boolean().default(true),
  userRuleDirs: z.array(z.string()).default(["~/.dsh/rules", "~/.claude/rules"]),
  projectRuleDirs: z.array(z.string()).default([".dsh/rules", ".claude/rules"]),
  maxRuleBytes: z.number().step(1).min(1024).default(65536),
  maxRulesBytes: z.number().step(1).min(1024).default(131072),
  maxRules: z.number().step(1).min(1).default(100)
});

/** Values used when `apply` is called directly with an incomplete config. */
export const DEFAULT_CONFIG: ConfigShape = {
  root: "auto-memory",
  maxIndexBytes: 25_600,
  maxIndexLines: 200,
  maxFileBytes: 65_536,
  maxFiles: 200,
  projectRootMarkers: [".git"],
  inject: true,
  injectInSubagents: false,
  guidance: true,
  rules: true,
  userRuleDirs: ["~/.dsh/rules", "~/.claude/rules"],
  projectRuleDirs: [".dsh/rules", ".claude/rules"],
  maxRuleBytes: 65_536,
  maxRulesBytes: 131_072,
  maxRules: 100
};

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`auto-memory: ${name} must be a positive safe integer`);
  }
  return value;
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`auto-memory: ${name} must be a non-empty string`);
  }
  return value;
}

function resolveDirs(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`auto-memory: ${name} must be an array of strings`);
  }
  return value.map((entry, index) => assertNonEmptyString(entry, `${name}[${index}]`));
}

function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`auto-memory: ${name} must be a boolean`);
  }
  return value;
}

/**
 * Resolve the configured memory root.
 *
 * @param configured - absolute path, `~`-prefixed path, or a path relative to
 *   the DeepSeek Harness home.
 * @returns normalized absolute directory.
 */
export function resolveMemoryRoot(configured: string): string {
  assertNonEmptyString(configured, "root");
  const expanded = expandHomePath(configured);
  return resolve(isAbsolute(expanded) ? expanded : join(resolveDshHome(), expanded));
}

/**
 * Normalize configuration for direct `apply` calls. Loader-normalized config
 * already carries schema defaults; this function still validates every value so
 * a bad programmatic mount fails loudly instead of creating a half-working
 * memory store.
 */
export function resolveConfig(config: Partial<ConfigShape> = {}): ResolvedConfig {
  const raw: Record<keyof ConfigShape, unknown> = { ...DEFAULT_CONFIG, ...config };
  const root = assertNonEmptyString(raw.root, "root");
  const markers = Array.isArray(raw.projectRootMarkers)
    ? raw.projectRootMarkers.map((marker, index) =>
        assertNonEmptyString(marker, `projectRootMarkers[${index}]`)
      )
    : (() => {
        throw new TypeError("auto-memory: projectRootMarkers must be an array of strings");
      })();
  const memoryRoot = resolveMemoryRoot(root);
  if (memoryRoot === resolveDshHome()) {
    throw new TypeError("auto-memory: root must be a dedicated directory, not $DSH_HOME itself");
  }
  if (memoryRoot === parse(memoryRoot).root) {
    throw new TypeError("auto-memory: root must not be a filesystem root");
  }
  const maxRuleBytes = positiveInteger(raw.maxRuleBytes, "maxRuleBytes");
  const maxRulesBytes = positiveInteger(raw.maxRulesBytes, "maxRulesBytes");
  if (maxRulesBytes < maxRuleBytes) {
    throw new TypeError("auto-memory: maxRulesBytes must be at least maxRuleBytes");
  }
  return {
    root,
    memoryRoot,
    maxIndexBytes: positiveInteger(raw.maxIndexBytes, "maxIndexBytes"),
    maxIndexLines: positiveInteger(raw.maxIndexLines, "maxIndexLines"),
    maxFileBytes: positiveInteger(raw.maxFileBytes, "maxFileBytes"),
    maxFiles: positiveInteger(raw.maxFiles, "maxFiles"),
    projectRootMarkers: markers,
    inject: assertBoolean(raw.inject, "inject"),
    injectInSubagents: assertBoolean(raw.injectInSubagents, "injectInSubagents"),
    guidance: assertBoolean(raw.guidance, "guidance"),
    rules: assertBoolean(raw.rules, "rules"),
    userRuleDirs: resolveDirs(raw.userRuleDirs, "userRuleDirs"),
    projectRuleDirs: resolveDirs(raw.projectRuleDirs, "projectRuleDirs"),
    maxRuleBytes,
    maxRulesBytes,
    maxRules: positiveInteger(raw.maxRules, "maxRules")
  };
}
