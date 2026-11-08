/**
 * Small glob matcher for rule `paths` patterns.
 *
 * Supports `*`, `**`, `?`, brace expansion (`{a,b}`), and character classes
 * (`[abc]`). Patterns are relative to the rule's base directory and use `/`
 * separators on every platform.
 */

const EXPANSION_BUDGET = 1000;
const COMPILED_CACHE = new Map<string, RegExp>();
const COMPILED_CACHE_LIMIT = 2000;
const NEVER = /^(?!)$/u;

function findBrace(pattern: string, from: number): { start: number; end: number } | undefined {
  let depth = 0;
  let start = -1;
  for (let index = from; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) return { start, end: index };
      }
    }
  }
  return undefined;
}

function splitAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of inner) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function expandInto(pattern: string, from: number, output: string[]): void {
  if (output.length >= EXPANSION_BUDGET) return;
  const brace = findBrace(pattern, from);
  if (brace === undefined) {
    output.push(pattern);
    return;
  }
  const alternatives = splitAlternatives(pattern.slice(brace.start + 1, brace.end));
  if (alternatives.length < 2) {
    expandInto(pattern, brace.end + 1, output);
    return;
  }
  const prefix = pattern.slice(0, brace.start);
  const suffix = pattern.slice(brace.end + 1);
  for (const alternative of alternatives) {
    if (output.length >= EXPANSION_BUDGET) break;
    expandInto(`${prefix}${alternative}${suffix}`, brace.start, output);
  }
}

/**
 * Expand brace alternatives with a hard budget. A pattern over budget is
 * returned unexpanded, so its literal braces match nothing rather than
 * consuming unbounded memory.
 */
export function expandBraces(pattern: string): string[] {
  const output: string[] = [];
  expandInto(pattern, 0, output);
  return output.length > 0 ? output : [pattern];
}

interface NormalizedPattern {
  pattern: string;
  anchored: boolean;
}

function normalizePattern(pattern: string): NormalizedPattern {
  let value = pattern.replace(/^\.\//u, "");
  if (value.startsWith("/")) {
    return { pattern: value.replace(/^\/+/, ""), anchored: true };
  }
  return { pattern: value, anchored: value.includes("/") };
}

function escapeRegex(character: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

/**
 * Compile one glob pattern into an anchored regular expression.
 */
export function compileGlob(pattern: string): RegExp {
  const cached = COMPILED_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  const normalized = normalizePattern(pattern);
  const source = normalized.pattern;
  let expression = normalized.anchored ? "^" : "^(?:.*/)?";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next !== undefined) {
        expression += escapeRegex(next);
        index += 1;
      } else {
        expression += "\\\\";
      }
      continue;
    }
    if (character === "*") {
      let end = index;
      while (source[end + 1] === "*") end += 1;
      if (end > index) {
        if (source[end + 1] === "/") {
          expression += "(?:.*/)?";
          index = end + 1;
        } else {
          expression += ".*";
          index = end;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    if (character === "[") {
      let close = -1;
      for (let cursor = index + 1; cursor < source.length; cursor += 1) {
        if (source[cursor] === "\\") {
          cursor += 1;
          continue;
        }
        if (source[cursor] === "]") {
          close = cursor;
          break;
        }
      }
      if (close === -1) {
        return NEVER;
      }
      let characterClass = source.slice(index + 1, close);
      if (characterClass.startsWith("!")) characterClass = `^${characterClass.slice(1)}`;
      expression += `[${characterClass}]`;
      index = close;
      continue;
    }
    if (character === "{" || character === "}") {
      expression += `\\${character}`;
      continue;
    }
    if ("\\.+^$()|".includes(character)) {
      expression += `\\${character}`;
      continue;
    }
    expression += character;
  }
  expression += "$";
  const compiled = new RegExp(expression);
  if (COMPILED_CACHE.size >= COMPILED_CACHE_LIMIT) COMPILED_CACHE.clear();
  COMPILED_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * Test one `/`-separated relative path against a glob.
 */
export function matchGlob(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return expandBraces(pattern).some((expanded) => compileGlob(expanded).test(normalized));
}
