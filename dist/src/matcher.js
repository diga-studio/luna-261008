"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeywordMatcher = void 0;
class KeywordMatcher {
    nodes = [];
    ids;
    constructor(rules) {
        this.ids = rules.map((rule) => rule.id);
        this.nodes.push({ children: new Map(), fail: 0, outputs: [] });
        rules.forEach((rule, index) => {
            let node = 0;
            for (const ch of rule.needle) {
                const next = this.nodes[node].children.get(ch);
                if (next === undefined) {
                    const created = this.nodes.length;
                    this.nodes.push({ children: new Map(), fail: 0, outputs: [] });
                    this.nodes[node].children.set(ch, created);
                    node = created;
                }
                else {
                    node = next;
                }
            }
            this.nodes[node].outputs.push(index);
        });
        this.buildFailLinks();
    }
    buildFailLinks() {
        const queue = [];
        for (const child of this.nodes[0].children.values()) {
            queue.push(child);
        }
        while (queue.length > 0) {
            const current = queue.shift();
            for (const [ch, child] of this.nodes[current].children) {
                let fallback = this.nodes[current].fail;
                while (fallback !== 0 && !this.nodes[fallback].children.has(ch)) {
                    fallback = this.nodes[fallback].fail;
                }
                const target = this.nodes[fallback].children.get(ch);
                this.nodes[child].fail = target !== undefined && target !== child ? target : 0;
                queue.push(child);
            }
        }
        for (let i = 1; i < this.nodes.length; i++) {
            const inherited = this.nodes[this.nodes[i].fail].outputs;
            if (inherited.length > 0) {
                this.nodes[i].outputs.push(...inherited);
            }
        }
    }
    createState() {
        return { node: 0 };
    }
    feed(state, text) {
        const hits = [];
        let node = state.node;
        for (const ch of text) {
            while (node !== 0 && !this.nodes[node].children.has(ch)) {
                node = this.nodes[node].fail;
            }
            const next = this.nodes[node].children.get(ch);
            node = next !== undefined ? next : 0;
            for (const ruleIndex of this.nodes[node].outputs) {
                hits.push(this.ids[ruleIndex]);
            }
        }
        state.node = node;
        return hits;
    }
}
exports.KeywordMatcher = KeywordMatcher;
