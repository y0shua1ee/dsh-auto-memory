/**
 * Parse the rule-file frontmatter used by Claude Code's `.claude/rules/`
 * format. Only `paths` is meaningful here; every other field is ignored.
 *
 * A file whose frontmatter cannot be read as a `paths` list is loaded
 * unconditionally, matching Claude Code's behavior for malformed YAML.
 */

const DELIMITER = "---";

function stripQuotes(value) {
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

function splitInlineList(value) {
  let body = value.trim();
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  const entries = [];
  let current = "";
  let quote = null;
  for (const character of body) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
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
 *
 * @param {string} content - complete rule file text.
 * @returns {{paths: string[] | undefined, body: string}} parsed rule.
 */
export function parseRule(content) {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) return { paths: undefined, body: source };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === DELIMITER) {
      end = index;
      break;
    }
  }
  if (end === -1) return { paths: undefined, body: source };

  const frontmatter = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/u, "");
  return { paths: parsePaths(frontmatter), body };
}

function parsePaths(frontmatter) {
  const index = frontmatter.findIndex((line) => /^paths\s*:/u.test(line));
  if (index === -1) return undefined;
  const value = frontmatter[index].replace(/^paths\s*:/u, "").trim();
  if (value.length > 0) {
    const inline = splitInlineList(value);
    return inline.length > 0 ? inline : undefined;
  }

  const paths = [];
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
