/**
 * Parse the rule-file frontmatter used by Claude Code's `.claude/rules/`
 * format. Only `paths` is meaningful here; every other field is ignored.
 *
 * A file whose frontmatter cannot be read as a `paths` list is loaded
 * unconditionally, matching Claude Code's behavior for malformed YAML.
 */

const DELIMITER = "---";

export interface ParsedRule {
  paths?: string[];
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isBalancedInline(value: string): boolean {
  let quote: string | null = null;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
      if (brackets < 0) return false;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
      if (braces < 0) return false;
    }
  }
  return quote === null && brackets === 0 && braces === 0;
}

function splitInlineList(value: string): string[] {
  let body = value.trim();
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  const entries: string[] = [];
  let current = "";
  let quote: string | null = null;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      current += character;
      if (character === "\\") {
        const next = body[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\\") {
      current += character;
      const next = body[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "," && brackets === 0 && braces === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);
  return entries.map(stripQuotes).filter((entry) => entry.length > 0);
}

/**
 * Read the rule body and its optional path patterns.
 */
export function parseRule(content: string): ParsedRule {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) return { body: source };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === DELIMITER) {
      end = index;
      break;
    }
  }
  if (end === -1) return { body: source };

  const frontmatter = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/u, "");
  const paths = parsePaths(frontmatter);
  return paths === undefined ? { body } : { paths, body };
}

function parsePaths(frontmatter: string[]): string[] | undefined {
  const index = frontmatter.findIndex((line) => /^paths\s*:/u.test(line));
  if (index === -1) return undefined;
  const value = frontmatter[index].replace(/^paths\s*:/u, "").trim();
  if (value.length > 0) {
    // A malformed inline list is a YAML parse failure: load the rule without
    // paths instead of scoping it to a pattern that can never match.
    if (!isBalancedInline(value)) return undefined;
    const inline = splitInlineList(value);
    return inline.length > 0 ? inline : undefined;
  }

  const paths: string[] = [];
  for (let cursor = index + 1; cursor < frontmatter.length; cursor += 1) {
    const line = frontmatter[cursor];
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const match = /^\s*-\s+(.*)$/u.exec(line);
    if (match === null) break;
    const path = stripQuotes(match[1]);
    if (path.length > 0) paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
}
