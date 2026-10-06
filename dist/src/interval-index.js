"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntervalIndex = void 0;
function compareKey(startA, idA, startB, idB) {
    if (startA !== startB)
        return startA < startB ? -1 : 1;
    if (idA === idB)
        return 0;
    return idA < idB ? -1 : 1;
}
function pull(node) {
    let maxEnd = node.end;
    if (node.left !== undefined && node.left.maxEnd > maxEnd)
        maxEnd = node.left.maxEnd;
    if (node.right !== undefined && node.right.maxEnd > maxEnd)
        maxEnd = node.right.maxEnd;
    node.maxEnd = maxEnd;
}
function rotateRight(node) {
    const child = node.left;
    node.left = child.right;
    child.right = node;
    pull(node);
    pull(child);
    return child;
}
function rotateLeft(node) {
    const child = node.right;
    node.right = child.left;
    child.left = node;
    pull(node);
    pull(child);
    return child;
}
class IntervalIndex {
    constructor() {
        this.root = undefined;
        this.count = 0;
    }
    get size() {
        return this.count;
    }
    insert(sessionId, start, end) {
        this.root = this.insertNode(this.root, {
            sessionId,
            start,
            end,
            maxEnd: end,
            priority: Math.random(),
            left: undefined,
            right: undefined,
        });
        this.count += 1;
    }
    insertNode(root, node) {
        if (root === undefined)
            return node;
        if (compareKey(node.start, node.sessionId, root.start, root.sessionId) < 0) {
            root.left = this.insertNode(root.left, node);
            pull(root);
            if (root.left.priority < root.priority)
                return rotateRight(root);
            return root;
        }
        root.right = this.insertNode(root.right, node);
        pull(root);
        if (root.right.priority < root.priority)
            return rotateLeft(root);
        return root;
    }
    /** 删除指定区间。调用方必须提供该场次当前记录中的 start（键的一部分）。 */
    remove(sessionId, start) {
        const [root, removed] = this.removeNode(this.root, sessionId, start);
        this.root = root;
        if (removed)
            this.count -= 1;
    }
    removeNode(root, sessionId, start) {
        if (root === undefined)
            return [undefined, false];
        const cmp = compareKey(start, sessionId, root.start, root.sessionId);
        if (cmp < 0) {
            const [left, removed] = this.removeNode(root.left, sessionId, start);
            root.left = left;
            pull(root);
            return [root, removed];
        }
        if (cmp > 0) {
            const [right, removed] = this.removeNode(root.right, sessionId, start);
            root.right = right;
            pull(root);
            return [root, removed];
        }
        if (root.left === undefined)
            return [root.right, true];
        if (root.right === undefined)
            return [root.left, true];
        if (root.left.priority < root.right.priority) {
            const rotated = rotateRight(root);
            const [right, removed] = this.removeNode(rotated.right, sessionId, start);
            rotated.right = right;
            pull(rotated);
            return [rotated, removed];
        }
        const rotated = rotateLeft(root);
        const [left, removed] = this.removeNode(rotated.left, sessionId, start);
        rotated.left = left;
        pull(rotated);
        return [rotated, removed];
    }
    /**
     * 对所有与 [start, end) 重叠（左闭右开，首尾相接不算重叠）的区间调用 visit。
     * skip 中的 sessionId 被忽略（用于排除批次内场次的旧区间）。
     */
    forEachOverlap(start, end, skip, visit) {
        this.query(this.root, start, end, skip, visit);
    }
    query(node, start, end, skip, visit) {
        if (node === undefined)
            return;
        if (node.maxEnd <= start)
            return; // 整棵子树都在 start 之前结束
        this.query(node.left, start, end, skip, visit);
        if (node.start >= end)
            return; // 右子树 start 均 >= 当前节点，不可能重叠
        if (node.end > start && (skip === null || !skip.has(node.sessionId))) {
            visit(node.sessionId, node.start, node.end);
        }
        this.query(node.right, start, end, skip, visit);
    }
}
exports.IntervalIndex = IntervalIndex;
