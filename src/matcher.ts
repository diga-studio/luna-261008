/**
 * Aho-Corasick 多模式串匹配。
 * 在归一化后的文本上查找全部词条的全部出现，包括互相重叠的命中。
 */

export interface NormalizedWord {
  /** 词条在词库中的下标。 */
  wordIndex: number;
  /** 归一化后的词条文本（保证非空）。 */
  normalized: string;
}

interface AcNode {
  next: Map<string, number>;
  fail: number;
  /** 以本节点结尾的词条下标（指向 normalizedWords）。 */
  outputs: number[];
}

export interface MatcherHit {
  wordIndex: number;
  /** 归一化文本中的半开区间（UTF-16 代码单元）。 */
  start: number;
  end: number;
}

export class Matcher {
  private nodes: AcNode[] = [];
  private words: NormalizedWord[];

  constructor(words: NormalizedWord[]) {
    this.words = words.filter((w) => w.normalized.length > 0);
    this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
    this.words.forEach((word, i) => this.insert(word.normalized, i));
    this.buildFailures();
  }

  private insert(text: string, wordIndex: number): void {
    let node = 0;
    for (const ch of text) {
      const child = this.nodes[node].next.get(ch);
      if (child !== undefined) {
        node = child;
      } else {
        const created = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        this.nodes[node].next.set(ch, created);
        node = created;
      }
    }
    this.nodes[node].outputs.push(wordIndex);
  }

  private buildFailures(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    while (queue.length > 0) {
      const state = queue.shift()!;
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
  findAll(text: string): MatcherHit[] {
    const hits: MatcherHit[] = [];
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
