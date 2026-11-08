/**
 * Parse the rule-file frontmatter used by Claude Code's `.claude/rules/`
 * format. Only `paths` is meaningful here; every other field is ignored.
 *
 * A file whose frontmatter cannot be read as a `paths` list is loaded
 * unconditionally, matching Claude Code's behavior for malformed YAML.
 */
export interface ParsedRule {
    paths?: string[];
    body: string;
}
/**
 * Read the rule body and its optional path patterns.
 */
export declare function parseRule(content: string): ParsedRule;
