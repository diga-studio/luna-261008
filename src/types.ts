/** MACB 时间类别。 */
export type EventKind = 'M' | 'A' | 'C' | 'B';

/** 事件类别排序权重：M < A < C < B。 */
export const EVENT_KIND_ORDER: readonly EventKind[] = ['M', 'A', 'C', 'B'];

/** 一条制品记录（一个版本）。时间为毫秒精度 UTC 时间戳，null 表示缺失。 */
export interface ArtifactRecord {
  /** 案件内唯一且不复用的数字编号。 */
  id: number;
  /** 标签集合。 */
  tags: string[];
  /** 修改时间。 */
  mtime: number | null;
  /** 访问时间。 */
  atime: number | null;
  /** 元数据变更时间。 */
  ctime: number | null;
  /** 创建时间。 */
  btime: number | null;
}

/** 时间线上的一个事件。 */
export interface TimelineEvent {
  artifactId: number;
  kind: EventKind;
  /** 毫秒精度 UTC 时间戳。 */
  timestamp: number;
}

/** 一页查询结果。 */
export interface TimelinePage {
  events: TimelineEvent[];
  /** 是否还有后续页。 */
  hasMore: boolean;
}
