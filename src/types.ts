/** 广告项目内容：五个字符串字段。 */
export interface AdContent {
  title: string;
  body: string;
  cta: string;
  backgroundColor: string;
  font: string;
}

/** 提交修改时携带的字段子集（至少一个字段）。 */
export type ContentPatch = Partial<AdContent>;

/** 一条完整修订。 */
export interface Revision {
  projectId: string;
  version: number;
  content: AdContent;
  createdAt: number;
}

/** 提交成功结果。 */
export interface SubmitSuccess {
  status: 'ok';
  /** 本次逻辑提交首次成功时产生的版本号。 */
  version: number;
  /** 首次成功时的完整内容。 */
  content: AdContent;
  /** true 表示命中有效去重窗口，未新增修订。 */
  deduplicated: boolean;
}

/** 版本冲突结果。 */
export interface SubmitConflict {
  status: 'conflict';
  currentVersion: number;
}

export type SubmitResult = SubmitSuccess | SubmitConflict;

export interface CreateProjectResult {
  projectId: string;
  version: number;
  content: AdContent;
}

export interface RevisionStoreOptions {
  /** SQLite 文件路径，默认内存库。 */
  dbPath?: string;
  /** 时钟（毫秒），便于测试控制去重窗口。 */
  now?: () => number;
}
