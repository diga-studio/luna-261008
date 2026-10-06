import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEGMENTS_PER_CYCLE,
  SETS_PER_SEGMENT,
  SetEntry,
  SetKey,
} from "../src/index";

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "train-")), "test.db");
}

export function keyOf(
  employeeId: string,
  exerciseId: string,
  week: number,
  session: number,
  set: number,
): SetKey {
  return { employeeId, exerciseId, week, session, set };
}

/** 段内第 i 组（0..17）对应的 (week, session, set)。 */
export function setPosInSegment(
  segment: number,
  i: number,
): { week: number; session: number; set: number } {
  return {
    week: (segment - 1) * 2 + Math.floor(i / 9) + 1,
    session: Math.floor((i % 9) / 3) + 1,
    set: (i % 3) + 1,
  };
}

/**
 * 独立重实现的曲线推导（用于与库内实现交叉验证）。
 * records: Map<"exercise|week|session|set", SetEntry>
 */
export function independentCurve(
  exerciseId: string,
  records: Map<string, SetEntry>,
): number[] {
  const recs: number[] = [40];
  for (let seg = 2; seg <= SEGMENTS_PER_CYCLE; seg++) {
    const prev = recs[recs.length - 1] as number;
    let ok = true;
    for (let i = 0; i < SETS_PER_SEGMENT; i++) {
      const pos = setPosInSegment(seg - 1, i);
      const entry = records.get(
        `${exerciseId}|${pos.week}|${pos.session}|${pos.set}`,
      );
      if (!entry || entry.reps < 10 || entry.weightLbs < prev) {
        ok = false;
        break;
      }
    }
    recs.push(ok ? prev + 5 : prev);
  }
  return recs;
}

/** 生成填满某动作某段的 18 条操作（weight/reps 可定制）。 */
export function fillSegmentOps(
  employeeId: string,
  exerciseId: string,
  segment: number,
  baseVersion: number,
  entry: SetEntry,
): Array<{ key: SetKey; baseVersion: number; entry: SetEntry }> {
  const ops = [];
  for (let i = 0; i < SETS_PER_SEGMENT; i++) {
    const pos = setPosInSegment(segment, i);
    ops.push({
      key: keyOf(employeeId, exerciseId, pos.week, pos.session, pos.set),
      baseVersion,
      entry,
    });
  }
  return ops;
}
