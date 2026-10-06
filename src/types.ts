export type Priority = "high" | "normal" | "low";

export type StageName = "compositing" | "encoding" | "applyingEffects";

export const STAGES: readonly StageName[] = [
  "compositing",
  "encoding",
  "applyingEffects",
];

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  /** 当前阶段；queued 或已终态且未进入过阶段时为 null */
  stage: StageName | null;
  /** 当前阶段进度 0..1；无进度信息时为 null */
  progress: number | null;
  /** 仅 completed 时存在 */
  outputPath: string | null;
  /** failed 时的错误信息 */
  error: string | null;
}

export type ProgressCallback = (progress: number) => void;

export type RunStage = (
  jobId: string,
  stage: StageName,
  inputPath: string,
  workDir: string,
  signal: AbortSignal,
  onProgress: ProgressCallback
) => Promise<string>;

export interface RenderQueueOptions {
  runStage: RunStage;
  /** 成品发布目录；缺省为临时目录下自动生成 */
  outputDir?: string;
  /** 工作目录根；缺省为临时目录下自动生成 */
  workRoot?: string;
  /** 物理槽位数，固定 10 */
  slots?: number;
  /** 测试/观测钩子 */
  hooks?: {
    /** 发布已发起、落盘完成前调用；返回的 Promise 会推迟落盘完成 */
    beforePublish?: (jobId: string) => void | Promise<void>;
    /** 作业执行与收尾 I/O 全部结束、槽位即将归还时调用 */
    afterCleanup?: (jobId: string) => void;
  };
}

export interface RenderQueue {
  submit(inputPath: string, priority: Priority): string;
  cancel(id: string): boolean;
  reprioritize(id: string, priority: Priority): boolean;
  snapshot(id: string): JobSnapshot | null;
}
