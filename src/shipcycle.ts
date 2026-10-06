import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { applyBatch, inTransaction, initRelease } from "./facts";
import { computeBasis, evaluateBlockers } from "./gate";
import {
  ConfirmResult,
  FactBatch,
  GateBasis,
  GatePreview,
  InitReleaseInput,
  ReleaseStatus,
} from "./types";

interface ReleaseRow {
  release_id: string;
  status: string;
  fact_version: number;
  released_basis: string | null;
}

/**
 * ShipCycle 发布门禁模块。
 *
 * 所有公开方法在单个同步区段内完成全部读写：node:sqlite 是同步驱动，
 * 同一进程内的并发调用因此在事件循环上天然串行，等价于按某个完整顺序执行，
 * 且保留不重叠调用的先后顺序。
 */
export class ShipCycle {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 初始化发布（Planning）。 */
  async initRelease(input: InitReleaseInput): Promise<void> {
    initRelease(this.db, input);
  }

  /** 批量更新门禁事实，整个批次原子生效。 */
  async applyBatch(releaseId: string, batch: FactBatch): Promise<void> {
    applyBatch(this.db, releaseId, batch);
  }

  /** 查看门禁：返回可发布性、阻塞原因、依据与确认凭据。 */
  async previewGate(releaseId: string): Promise<GatePreview> {
    const row = this.requireRelease(releaseId);
    const basis = computeBasis(this.db, releaseId);
    const blockers = evaluateBlockers(basis);
    return {
      releaseId,
      status: row.status as ReleaseStatus,
      releasable: blockers.length === 0 && row.status === "Planning",
      blockers,
      basis,
      token: this.issueToken(releaseId, row.fact_version),
    };
  }

  /** 携带仍有效的凭据确认发布。 */
  async confirmRelease(releaseId: string, token: string): Promise<ConfirmResult> {
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT release_id, status, fact_version, released_basis FROM releases WHERE release_id = ?",
        )
        .get(releaseId) as ReleaseRow | undefined;
      if (!row) {
        return { ok: false, releaseId, status: "Planning", error: `release not found: ${releaseId}` };
      }
      if (row.status === "Released") {
        return {
          ok: false,
          releaseId,
          status: "Released",
          error: `release ${releaseId} has already been confirmed`,
        };
      }
      const parsed = this.parseToken(token);
      if (!parsed || parsed.releaseId !== releaseId) {
        return { ok: false, releaseId, status: "Planning", error: "invalid confirmation token" };
      }
      if (parsed.factVersion !== row.fact_version) {
        return {
          ok: false,
          releaseId,
          status: "Planning",
          error: "confirmation token expired: gate facts changed since preview",
        };
      }
      // 凭据有效，在同一次完整判断中检查全部门禁。
      const basis = computeBasis(this.db, releaseId);
      const blockers = evaluateBlockers(basis);
      if (blockers.length > 0) {
        return { ok: false, releaseId, status: "Planning", error: "gate not satisfied", blockers };
      }
      // 成功：保存 Released 状态与不可变门禁依据；此后事实变化不再回写本记录。
      this.db
        .prepare("UPDATE releases SET status = 'Released', released_basis = ? WHERE release_id = ?")
        .run(JSON.stringify(basis), releaseId);
      return { ok: true, releaseId, status: "Released", basis };
    });
  }

  /** 读取已确认发布保存的不可变门禁依据；未确认返回 null。 */
  async getReleasedBasis(releaseId: string): Promise<GateBasis | null> {
    const row = this.db
      .prepare("SELECT released_basis FROM releases WHERE release_id = ?")
      .get(releaseId) as { released_basis: string | null } | undefined;
    if (!row || row.released_basis === null) return null;
    return JSON.parse(row.released_basis) as GateBasis;
  }

  /** 关闭底层数据库。 */
  close(): void {
    this.db.close();
  }

  private requireRelease(releaseId: string): ReleaseRow {
    const row = this.db
      .prepare(
        "SELECT release_id, status, fact_version, released_basis FROM releases WHERE release_id = ?",
      )
      .get(releaseId) as ReleaseRow | undefined;
    if (!row) throw new Error(`release not found: ${releaseId}`);
    return row;
  }

  private issueToken(releaseId: string, factVersion: number): string {
    const nonce = randomBytes(8).toString("hex");
    return `sc1.${releaseId}.${factVersion}.${nonce}`;
  }

  private parseToken(token: string): { releaseId: string; factVersion: number } | null {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "sc1") return null;
    const factVersion = Number(parts[2]);
    if (!Number.isInteger(factVersion) || factVersion < 0) return null;
    return { releaseId: parts[1] as string, factVersion };
  }
}
