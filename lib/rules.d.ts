import type { RuleScope } from "./types.js";
/** Message source kind used to recognize injected rule batches. */
export declare const RULE_MESSAGE_KIND = "auto-rules";
export interface Rule {
    key: string;
    path: string;
    scope: RuleScope;
    body: string;
    paths?: string[];
    matchers: RegExp[];
    digest: string;
    bytes: number;
}
export interface RuleIndexOptions {
    userRuleDirs: string[];
    projectRuleDirs: string[];
    maxRuleBytes: number;
    maxRules: number;
    maxRulesBytes: number;
}
export interface CollectInput {
    cwd: string;
    projectRoot: string;
}
export interface CollectResult {
    rules: Rule[];
    warnings: string[];
}
/** The subset of a rule that rendering needs. */
export interface RenderableRule {
    key: string;
    path: string;
    scope: RuleScope;
    body: string;
    digest: string;
}
export interface RenderedRules {
    text: string;
    digest: string;
    rules: RenderableRule[];
}
/**
 * Discover and cache rule files from user and project roots.
 *
 * Files are re-stat'ed on every collection; content is read again only when
 * size or mtime changes. Symlinks are followed, which is required for the
 * Home Manager-managed rules under `~/.claude/rules/`.
 */
export declare class RuleIndex {
    #private;
    readonly userRuleDirs: string[];
    readonly projectRuleDirs: string[];
    readonly maxRuleBytes: number;
    readonly maxRules: number;
    readonly maxRulesBytes: number;
    constructor({ userRuleDirs, projectRuleDirs, maxRuleBytes, maxRules, maxRulesBytes }: RuleIndexOptions);
    /**
     * Collect the rules visible to one session.
     */
    collect({ cwd, projectRoot }: CollectInput): Promise<CollectResult>;
}
export declare function renderRules(rules: RenderableRule[], maxBytes: number, warnings?: string[]): RenderedRules | undefined;
