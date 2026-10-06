import type { AllocationRequest } from "./types";

/** 校验输入，非法输入抛出 Error。 */
export function validateRequest(request: AllocationRequest): void {
  if (request === null || typeof request !== "object") {
    throw new Error("request 必须是对象");
  }
  const { materials, groups, allowed } = request;
  if (!Array.isArray(materials) || !Array.isArray(groups) || !Array.isArray(allowed)) {
    throw new Error("request.materials / request.groups / request.allowed 必须是数组");
  }

  const materialIds = new Set<string>();
  for (const m of materials) {
    if (!m || typeof m.materialId !== "string" || m.materialId.length === 0) {
      throw new Error("素材 materialId 必须是非空字符串");
    }
    if (materialIds.has(m.materialId)) {
      throw new Error(`素材 materialId 重复: ${m.materialId}`);
    }
    materialIds.add(m.materialId);
    if (!Number.isSafeInteger(m.capacity) || m.capacity < 0) {
      throw new Error(`素材 ${m.materialId} 的 capacity 必须是非负安全整数`);
    }
  }

  const groupKeys = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g.regionCode !== "string" || g.regionCode.length === 0
      || typeof g.segmentId !== "string" || g.segmentId.length === 0) {
      throw new Error("人群组 regionCode / segmentId 必须是非空字符串");
    }
    const key = groupKey(g.regionCode, g.segmentId);
    if (groupKeys.has(key)) {
      throw new Error(`人群组重复: ${g.regionCode} / ${g.segmentId}`);
    }
    groupKeys.add(key);
    if (!Number.isSafeInteger(g.demand) || g.demand < 0) {
      throw new Error(`人群组 ${key} 的 demand 必须是非负安全整数`);
    }
    if (!Array.isArray(g.branches) || g.branches.length < 2 || g.branches.length > 5) {
      throw new Error(`人群组 ${key} 的实验分支数必须在 2 至 5 之间`);
    }
    const branchIds = new Set<number>();
    let percentSum = 0;
    for (const b of g.branches) {
      if (!Number.isSafeInteger(b.branchId) || b.branchId <= 0) {
        throw new Error(`人群组 ${key} 的分支编号必须是正整数`);
      }
      if (branchIds.has(b.branchId)) {
        throw new Error(`人群组 ${key} 的分支编号重复: ${b.branchId}`);
      }
      branchIds.add(b.branchId);
      if (!Number.isSafeInteger(b.percent) || b.percent <= 0) {
        throw new Error(`人群组 ${key} 分支 ${b.branchId} 的百分比必须是大于 0 的整数`);
      }
      percentSum += b.percent;
    }
    if (percentSum !== 100) {
      throw new Error(`人群组 ${key} 的百分比合计必须为 100，实际为 ${percentSum}`);
    }
  }

  const branchExists = new Set<string>();
  for (const g of groups) {
    for (const b of g.branches) {
      branchExists.add(`${groupKey(g.regionCode, g.segmentId)}${b.branchId}`);
    }
  }
  for (const c of allowed) {
    if (!c || !materialIds.has(c.materialId)) {
      throw new Error(`允许组合引用了不存在的素材: ${c?.materialId}`);
    }
    if (!groupKeys.has(groupKey(c.regionCode, c.segmentId))) {
      throw new Error(`允许组合引用了不存在的人群组: ${c.regionCode} / ${c.segmentId}`);
    }
    if (!branchExists.has(`${groupKey(c.regionCode, c.segmentId)}${c.branchId}`)) {
      throw new Error(`允许组合引用了不存在的分支: ${c.regionCode} / ${c.segmentId} / ${c.branchId}`);
    }
    if (!Number.isSafeInteger(c.profitPerImpression)) {
      throw new Error(`组合 ${c.materialId} -> ${c.regionCode}/${c.segmentId}/${c.branchId} 的收益分必须是安全整数`);
    }
  }
}

export function groupKey(regionCode: string, segmentId: string): string {
  return `${regionCode}${segmentId}`;
}
