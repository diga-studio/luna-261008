/**
 * Aho-Corasick 多模式串匹配。
 * 在归一化后的文本上查找全部词条的全部出现，包括互相重叠的命中。
 */
export class Matcher {
    nodes = [];
    words;
    constructor(words) {
        this.words = words.filter((w) => w.normalized.length > 0);
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        this.words.forEach((word, i) => this.insert(word.normalized, i));
        this.buildFailures();
    }
    insert(text, wordIndex) {
        let node = 0;
        for (const ch of text) {
            const child = this.nodes[node].next.get(ch);
            if (child !== undefined) {
                node = child;
            }
            else {
                const created = this.nodes.length;
                this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
                this.nodes[node].next.set(ch, created);
                node = created;
            }
        }
        this.nodes[node].outputs.push(wordIndex);
    }
    buildFailures() {
        const queue = [];
        for (const child of this.nodes[0].next.values()) {
            this.nodes[child].fail = 0;
            queue.push(child);
        }
        while (queue.length > 0) {
            const state = queue.shift();
            for (const [ch, child] of this.nodes[state].next) {
                let fallback = this.nodes[state].fail;
                while (fallback !== 0 && !this.nodes[fallback].next.has(ch)) {
                    fallback = this.nodes[fallback].fail;
                }
                const target = this.nodes[fallback].next.get(ch);
                this.nodes[child].fail = target !== undefined && target !== child ? target : 0;
                queue.push(child);
            }
        }
    }
    /** 返回文本中全部命中（含重叠），按结束位置升序。 */
    findAll(text) {
        const hits = [];
        let state = 0;
        let index = 0;
        for (const ch of text) {
            const width = ch.length;
            while (state !== 0 && !this.nodes[state].next.has(ch)) {
                state = this.nodes[state].fail;
            }
            state = this.nodes[state].next.get(ch) ?? 0;
            // 沿 fail 链收集所有以当前位置结尾的词条。
            for (let probe = state; probe !== 0; probe = this.nodes[probe].fail) {
                for (const wordIdx of this.nodes[probe].outputs) {
                    const normalized = this.words[wordIdx].normalized;
                    hits.push({
                        wordIndex: this.words[wordIdx].wordIndex,
                        start: index + width - normalized.length,
                        end: index + width,
                    });
                }
            }
            index += width;
        }
        return hits;
    }
}
