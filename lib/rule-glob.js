/**
 * Small glob matcher for rule `paths` patterns.
 *
 * Supports `*`, `**`, `?`, brace expansion (`{a,b}`), and character classes
 * (`[abc]`). Patterns are relative to the rule's base directory and use `/`
 * separators on every platform.
 */

const EXPANSION_BUDGET = 1000;
const COMPILED_CACHE = new Map();
const COMPILED_CACHE_LIMIT = 2000;

function findBrace(pattern, from) {
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

function splitAlternatives(inner) {
  const parts = [];
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

function expandInto(pattern, from, output) {
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
 *
 * @param {string} pattern - glob pattern.
 * @returns {string[]} expanded patterns.
 */
export function expandBraces(pattern) {
  const output = [];
  expandInto(pattern, 0, output);
  return output.length > 0 ? output : [pattern];
}

function normalizePattern(pattern) {
  return pattern.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
}

/**
 * Compile one glob pattern into an anchored regular expression.
 *
 * @param {string} pattern - glob pattern.
 * @returns {RegExp} matcher for `/`-separated relative paths.
 */
export function compileGlob(pattern) {
  const cached = COMPILED_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  const source = normalizePattern(pattern);
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
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
      const close = source.indexOf("]", index + 1);
      if (close === -1) {
        expression += "\\[";
        continue;
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
 *
 * @param {string} path - relative path.
 * @param {string} pattern - glob pattern.
 * @returns {boolean} whether the path matches.
 */
export function matchGlob(path, pattern) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return expandBraces(pattern).some((expanded) => compileGlob(expanded).test(normalized));
}
