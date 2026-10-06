import type { Rule } from "./types.js";

interface Node {
  next: Map<number, Node>;
  fail: Node | null;
  /** 在该节点结束的规则下标。 */
  outputs: number[];
  /** 失败链上最近的有输出的祖先（不含自身），无则为 null。 */
  outLink: Node | null;
}

/**
 * 流式关键词匹配器（Aho-Corasick）。
 * 按解码后的字符（UTF-16 码元）精确、大小写敏感匹配；
 * 状态只随规则总规模增长，可跨任意输入块。
 */
export class KeywordMatcher {
  private readonly rules: Rule[];
  private readonly root: Node;
  private state: Node;
  private readonly hit: boolean[];

  constructor(rules: Rule[]) {
    this.rules = rules;
    this.hit = new Array<boolean>(rules.length).fill(false);
    this.root = KeywordMatcher.makeNode();
    this.state = this.root;

    for (let i = 0; i < rules.length; i++) {
      let node = this.root;
      for (const ch of rules[i]!.needle) {
        const code = ch.charCodeAt(0);
        let child = node.next.get(code);
        if (child === undefined) {
          child = KeywordMatcher.makeNode();
          node.next.set(code, child);
        }
        node = child;
      }
      node.outputs.push(i);
    }

    // BFS 构建失败指针与输出链接。
    const queue: Node[] = [];
    for (const child of this.root.next.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [code, child] of node.next) {
        let fallback = node.fail!;
        while (fallback !== this.root && !fallback.next.has(code)) {
          fallback = fallback.fail!;
        }
        const target = fallback.next.get(code);
        child.fail = target !== undefined && target !== child ? target : this.root;
        child.outLink =
          child.fail.outputs.length > 0 ? child.fail : child.fail.outLink;
        queue.push(child);
      }
    }
  }

  private static makeNode(): Node {
    return { next: new Map(), fail: null, outputs: [], outLink: null };
  }

  private collect(node: Node, fresh: string[]): void {
    for (const index of node.outputs) {
      if (!this.hit[index]) {
        this.hit[index] = true;
        fresh.push(this.rules[index]!.id);
      }
    }
  }

  /** 喂入一段已解码文本，返回本次新命中的规则 id（按命中出现顺序）。 */
  feed(text: string): string[] {
    const fresh: string[] = [];
    let node = this.state;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      while (node !== this.root && !node.next.has(code)) {
        node = node.fail!;
      }
      node = node.next.get(code) ?? this.root;
      if (node.outputs.length > 0) {
        this.collect(node, fresh);
      }
      // 沿输出链接收集后缀命中。
      for (let out = node.outLink; out !== null; out = out.outLink) {
        this.collect(out, fresh);
      }
    }
    this.state = node;
    return fresh;
  }

  /** 目前已命中的全部规则 id（按规则声明顺序）。 */
  hitIds(): string[] {
    const ids: string[] = [];
    for (let i = 0; i < this.rules.length; i++) {
      if (this.hit[i]) {
        ids.push(this.rules[i]!.id);
      }
    }
    return ids;
  }
}
