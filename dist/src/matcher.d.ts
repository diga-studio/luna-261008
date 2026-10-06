import { Rule } from "./types";
export interface MatcherState {
    node: number;
}
export declare class KeywordMatcher {
    private nodes;
    private ids;
    constructor(rules: Rule[]);
    private buildFailLinks;
    createState(): MatcherState;
    feed(state: MatcherState, text: string): string[];
}
