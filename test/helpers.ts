import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACB_KINDS } from "../src/types.js";
import type { ArtifactRecord, TimelineEvent } from "../src/types.js";

export function tempDbPath(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "forensic-timeline-"));
  return {
    dir,
    dbPath: join(dir, "case.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const KIND_RANK: Record<string, number> = { M: 0, A: 1, C: 2, B: 3 };

/** 独立参照实现：顺序应用批次（同编号整条替换），得到某一证据版本下的制品状态 */
export function applyBatches(batches: ArtifactRecord[][]): Map<number, ArtifactRecord> {
  const state = new Map<number, ArtifactRecord>();
  for (const batch of batches) {
    for (const record of batch) {
      state.set(record.id, {
        id: record.id,
        tags: [...new Set(record.tags)].sort(),
        times: { ...record.times },
      });
    }
  }
  return state;
}

/** 独立参照实现：由制品状态全量计算时间线（数量、顺序、内容） */
export function computeTimeline(
  state: Map<number, ArtifactRecord>,
  tag?: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const record of state.values()) {
    if (tag !== undefined && !record.tags.includes(tag)) continue;
    for (const kind of MACB_KINDS) {
      const time = record.times[kind];
      if (time === null) continue;
      events.push({
        artifactId: record.id,
        kind,
        time,
        tags: [...record.tags].sort(),
      });
    }
  }
  events.sort(
    (a, b) =>
      a.time - b.time ||
      a.artifactId - b.artifactId ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind]
  );
  return events;
}
