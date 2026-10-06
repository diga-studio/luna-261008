import { randomUUID } from 'node:crypto';
import { completeContent, contentKey, validatePatch, CONTENT_FIELDS } from './contentKey';
import { Database } from './database';
import {
  AdContent,
  ContentPatch,
  ProjectState,
  Revision,
  RevisionStoreOptions,
  SubmitResult,
} from './types';

export const DEFAULT_DEDUP_WINDOW_MS = 5000;
export const HISTORY_LIMIT = 20;

/** 广告项目修订提交库主入口，由上层创意编辑器直接调用。 */
export class RevisionStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly dedupWindowMs: number;

  constructor(dbPath: string, options: RevisionStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.now = options.now ?? (() => Date.now());
    this.dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  }

  close(): void {
    this.db.close();
  }

  /** 创建项目，保存完整内容，初始版本号为 1。 */
  createProject(content: AdContent): ProjectState {
    validateFullContent(content);
    const projectId = randomUUID();
    this.db.createProject(projectId, content, this.now());
    return { projectId, version: 1, content: { ...content } };
  }

  /** 提交修改：携带基线版本号与任意非空字段子集。 */
  submitChange(projectId: string, baseVersion: number, patch: ContentPatch): SubmitResult {
    validatePatch(patch);
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new TypeError('baseVersion 必须是 >= 1 的整数');
    }
    if (!this.db.projectExists(projectId)) {
      throw new Error(`项目不存在: ${projectId}`);
    }

    const base = this.db.getRevision(projectId, baseVersion);
    if (base === null) {
      // 基线版本大于当前版本（尚未存在），视为冲突。
      return { status: 'conflict', currentVersion: this.db.currentVersion(projectId)! };
    }

    // 缺失字段沿用基线修订的值，补全后得到完整内容身份。
    const full = completeContent(base.content, patch);
    const key = contentKey(full);

    // 有效去重优先于版本冲突判断；窗口从首次成功起算，恰好到期即失效。
    const dedup = this.db.findDedup(projectId, baseVersion, key);
    if (dedup !== null && this.now() - dedup.firstSuccessAt < this.dedupWindowMs) {
      return {
        status: 'ok',
        version: dedup.resultVersion,
        content: dedup.content,
        deduplicated: true,
      };
    }

    const currentVersion = this.db.currentVersion(projectId)!;
    if (baseVersion !== currentVersion) {
      return { status: 'conflict', currentVersion };
    }

    const committed = this.db.commitRevision(
      projectId,
      baseVersion,
      full,
      { baseVersion, contentKey: key, firstSuccessAt: this.now() },
      this.now(),
    );
    if (committed === null) {
      // 并发下当前版本在事务内已变化。
      return { status: 'conflict', currentVersion: this.db.currentVersion(projectId)! };
    }
    return { status: 'ok', version: committed.version, content: committed.content, deduplicated: false };
  }

  /** 查看当前内容。 */
  getCurrent(projectId: string): ProjectState {
    const version = this.db.currentVersion(projectId);
    if (version === null) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    const revision = this.db.getRevision(projectId, version)!;
    return { projectId, version, content: revision.content };
  }

  /** 修订历史：最近 20 个完整修订（含当前），按版本升序。 */
  getHistory(projectId: string): Revision[] {
    if (!this.db.projectExists(projectId)) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    return this.db.recentRevisions(projectId, HISTORY_LIMIT);
  }
}

function validateFullContent(content: AdContent): void {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new TypeError('content 必须是对象');
  }
  for (const field of CONTENT_FIELDS) {
    if (typeof (content as unknown as Record<string, unknown>)[field] !== 'string') {
      throw new TypeError(`字段 ${field} 必须是字符串`);
    }
  }
}
