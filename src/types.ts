/** MACB 时间类别，固定顺序用于事件排序 */
export const MACB_KINDS = ["M", "A", "C", "B"] as const;
export type MacbKind = (typeof MACB_KINDS)[number];

/** 制品记录：编号案件内唯一且不复用；时间为毫秒精度 UTC，null 表示缺失 */
export interface ArtifactRecord {
  id: number;
  tags: string[];
  times: {
    M: number | null;
    A: number | null;
    C: number | null;
    B: number | null;
  };
}

/** 时间线上的一个事件 */
export interface TimelineEvent {
  artifactId: number;
  kind: MacbKind;
  /** 毫秒精度 UTC 时间戳 */
  time: number;
  /** 事件所属制品在快照版本下的标签集合（升序、去重） */
  tags: string[];
}

/** 一页查询结果 */
export interface TimelinePage {
  /** 快照标识，续页与结束快照时使用 */
  snapshotId: string;
  events: TimelineEvent[];
  /** 是否还有后续页 */
  hasMore: boolean;
}

/** 首屏查询选项 */
export interface FirstPageOptions {
  /** 标签完全相等过滤；缺省不过滤 */
  tag?: string;
  pageSize: number;
}
