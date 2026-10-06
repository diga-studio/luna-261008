/** 广告项目内容：五个字符串字段。 */
export interface AdContent {
  title: string;
  body: string;
  cta: string;
  backgroundColor: string;
  font: string;
}

/** 修改提交：任意非空字段子集。 */
export type ContentPatch = Partial<AdContent>;

/** 一条完整修订。 */
export interface Revision {
  projectId: string;
  version: number;
  content: AdContent;
  createdAt: number;
}

/** 提交成功。 */
export interface SubmitSuccess {
  status: 'ok';
  /** 本次提交归属的版本号（去重命中时返回首次成功的版本号）。 */
  version: number;
  /** 该版本的完整内容。 */
  content: AdContent;
  /** true 表示命中去重窗口，未新增修订。 */
  deduplicated: boolean;
}

/** 版本冲突：基线版本不等于当前版本，且未命中有效去重。 */
export interface SubmitConflict {
  status: 'conflict';
  currentVersion: number;
}

export type SubmitResult = SubmitSuccess | SubmitConflict;

/** 项目当前状态。 */
export interface ProjectState {
  projectId: string;
  version: number;
  content: AdContent;
}

export interface RevisionStoreOptions {
  /** 注入时钟（毫秒），便于测试去重窗口边界。默认 Date.now。 */
  now?: () => number;
  /** 去重窗口时长（毫秒），固定 5000。 */
  dedupWindowMs?: number;
}
