export * from "./types";
export { FileSourceStore } from "./source";
export { FileSink } from "./sink";
export type { SinkHooks } from "./sink";
export { FileProgressStore } from "./progress";
export { SyncEngine } from "./engine";

import { FileSourceStore } from "./source";
import { FileSink, SinkHooks } from "./sink";
import { FileProgressStore } from "./progress";
import { SyncEngine } from "./engine";
import * as path from "node:path";

/** 一整套本地组件：来源、接收端、进度各自独立落盘，外加同步执行器。 */
export interface LocalStack {
  source: FileSourceStore;
  sink: FileSink;
  progress: FileProgressStore;
  engine: SyncEngine;
}

/**
 * 在给定目录下打开（或创建）一整套本地同步组件。
 * 重新以同一目录调用即可从上次中断处恢复。
 */
export function openLocalStack(
  dir: string,
  options?: { batchSize?: number; sinkHooks?: SinkHooks },
): LocalStack {
  const source = new FileSourceStore(path.join(dir, "source"));
  const sink = new FileSink(path.join(dir, "sink"), options?.sinkHooks);
  const progress = new FileProgressStore(path.join(dir, "progress"));
  const engine = new SyncEngine(source, sink, progress, options?.batchSize);
  return { source, sink, progress, engine };
}
