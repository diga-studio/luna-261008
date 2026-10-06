"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLeaf = exports.DIMENSION_WEIGHTS = void 0;
/** 维度固定权重 */
exports.DIMENSION_WEIGHTS = {
    manager: 50,
    peer: 30,
    self: 20,
};
function isLeaf(node) {
    return !('children' in node);
}
exports.isLeaf = isLeaf;
