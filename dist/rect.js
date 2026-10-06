function makeRect(srcMin, srcMax, dstMin, dstMax, portMin, portMax) {
    if (srcMin > srcMax || dstMin > dstMax || portMin > portMax) {
        return null;
    }
    return { srcMin, srcMax, dstMin, dstMax, portMin, portMax };
}
/** 从单个矩形中减去 block，返回剩余的不重叠矩形（0 到 6 个）。 */
function subtractOne(rect, block) {
    // 无交集则原样保留。
    if (rect.srcMax < block.srcMin ||
        rect.srcMin > block.srcMax ||
        rect.dstMax < block.dstMin ||
        rect.dstMin > block.dstMax ||
        rect.portMax < block.portMin ||
        rect.portMin > block.portMax) {
        return [rect];
    }
    const out = [];
    const push = (r) => {
        if (r !== null)
            out.push(r);
    };
    // 源地址维度：交集之外的两段。
    push(makeRect(rect.srcMin, block.srcMin - 1n, rect.dstMin, rect.dstMax, rect.portMin, rect.portMax));
    push(makeRect(block.srcMax + 1n, rect.srcMax, rect.dstMin, rect.dstMax, rect.portMin, rect.portMax));
    // 源地址交集内，目的地址维度的两段。
    const srcMin = rect.srcMin > block.srcMin ? rect.srcMin : block.srcMin;
    const srcMax = rect.srcMax < block.srcMax ? rect.srcMax : block.srcMax;
    push(makeRect(srcMin, srcMax, rect.dstMin, block.dstMin - 1n, rect.portMin, rect.portMax));
    push(makeRect(srcMin, srcMax, block.dstMax + 1n, rect.dstMax, rect.portMin, rect.portMax));
    // 源、目的交集内，端口维度的两段。
    const dstMin = rect.dstMin > block.dstMin ? rect.dstMin : block.dstMin;
    const dstMax = rect.dstMax < block.dstMax ? rect.dstMax : block.dstMax;
    push(makeRect(srcMin, srcMax, dstMin, dstMax, rect.portMin, block.portMin - 1));
    push(makeRect(srcMin, srcMax, dstMin, dstMax, block.portMax + 1, rect.portMax));
    return out;
}
/** 从 rects 中减去 block，返回剩余矩形列表（精确、不重叠）。 */
export function subtractRect(rects, block) {
    const out = [];
    for (const rect of rects) {
        for (const piece of subtractOne(rect, block)) {
            out.push(piece);
        }
    }
    return out;
}
//# sourceMappingURL=rect.js.map