export type Priority = 'high' | 'normal' | 'low';

export type Stage = 'compositing' | 'encoding' | 'applyingEffects';

export const STAGES: readonly Stage[] = ['compositing', 'encoding', 'applyingEffects'];

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Snapshot {
  readonly status: JobStatus;
  readonly stage: Stage | null;
  readonly stageProgress: number | null;
  readonly outputPath?: string;
}

export type ProgressCallback = (progress: number) => void;

export type RunStage = (
  jobId: string,
  stage: Stage,
  inputPath: string,
  workDir: string,
  signal: AbortSignal,
  onProgress: ProgressCallback,
) => Promise<string>;

export interface RenderQueueOptions {
  readonly runStage: RunStage;
  readonly outputDir: string;
  readonly workRoot: string;
  readonly slots?: number;
}
